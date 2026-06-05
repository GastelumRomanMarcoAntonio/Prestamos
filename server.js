const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const createPdf = (res, filename, buildDoc) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
        const result = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.send(result);
    });
    buildDoc(doc);
    doc.end();
};

if (!databaseUrl) {
    console.error('ERROR: No se encontró DATABASE_URL. Configura una base de datos PostgreSQL en Render o define la variable de entorno DATABASE_URL.');
    process.exit(1);
}

const useSsl = process.env.NODE_ENV === 'production'
    || process.env.PGSSLMODE === 'require'
    || databaseUrl.includes('render.com');

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL client error', err);
    process.exit(-1);
});

const db = {
    get(sql, params, cb) {
        pool.query(sql, params)
            .then(result => cb(null, result.rows[0]))
            .catch(cb);
    },
    all(sql, params, cb) {
        pool.query(sql, params)
            .then(result => cb(null, result.rows))
            .catch(cb);
    },
    run(sql, params, cb) {
        pool.query(sql, params)
            .then(result => cb(null, { lastID: result.rows[0]?.id, rowCount: result.rowCount }))
            .catch(cb);
    }
};

const initDb = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            nombre TEXT NOT NULL,
            usuario TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            rol TEXT NOT NULL DEFAULT 'cajero'
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS clientes (
            id SERIAL PRIMARY KEY,
            nombre TEXT NOT NULL,
            paterno TEXT NOT NULL,
            materno TEXT,
            fecha_nac DATE,
            curp TEXT UNIQUE NOT NULL,
            rfc TEXT,
            telefono TEXT,
            correo TEXT,
            direccion TEXT,
            fecha_registro TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS prestamos (
            id SERIAL PRIMARY KEY,
            id_cliente INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
            monto NUMERIC NOT NULL,
            plazo INTEGER NOT NULL,
            tasa NUMERIC NOT NULL,
            pago_semanal NUMERIC,
            estado TEXT DEFAULT 'pendiente',
            motivo_rechazo TEXT,
            fecha_solicitud TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            fecha_aprobacion TIMESTAMPTZ
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS pagos (
            id SERIAL PRIMARY KEY,
            id_prestamo INTEGER NOT NULL REFERENCES prestamos(id) ON DELETE CASCADE,
            monto_pagado NUMERIC NOT NULL,
            fecha_pago TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS auditoria (
            id SERIAL PRIMARY KEY,
            usuario TEXT,
            modulo TEXT,
            accion TEXT,
            detalle TEXT,
            fecha TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`INSERT INTO usuarios (nombre, usuario, password, rol)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (usuario) DO NOTHING`,
            ['Administrador', 'admin', 'admin123', 'admin']
        );

        console.log('✅ Conectado a PostgreSQL y tablas creadas/verificadas correctamente');
    } catch (err) {
        console.error('Error al inicializar la base de datos PostgreSQL:', err);
        process.exit(1);
    }
};

initDb();

// ─── RUTAS: AUTENTICACIÓN ────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
    const { usuario, password } = req.body;
    db.get(
        `SELECT id, nombre, usuario, rol FROM usuarios WHERE usuario = $1 AND password = $2`,
        [usuario, password],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(401).json({ error: 'Credenciales incorrectas' });
            res.json({ success: true, usuario: row });
        }
    );
});

// ─── RUTAS: CLIENTES ─────────────────────────────────────────────────────────
app.get('/api/clientes', (req, res) => {
    db.all(
        `SELECT c.*, 
                COALESCE((
                    SELECT SUM(
                        (p.pago_semanal * p.plazo) - COALESCE((SELECT SUM(monto_pagado) FROM pagos WHERE id_prestamo = p.id), 0)
                    )
                    FROM prestamos p
                    WHERE p.id_cliente = c.id AND p.estado = 'activo'
                ), 0) AS saldo_pendiente
         FROM clientes c
         ORDER BY c.id DESC`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/clientes', (req, res) => {
    const { nombre, paterno, materno, fecha_nac, curp, rfc, telefono, correo, direccion } = req.body;
    db.run(
        `INSERT INTO clientes (nombre, paterno, materno, fecha_nac, curp, rfc, telefono, correo, direccion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [nombre, paterno, materno, fecha_nac, curp, rfc, telefono, correo, direccion],
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`INSERT INTO auditoria (usuario, modulo, accion, detalle) VALUES ($1, $2, $3, $4)`,
                ['sistema', 'Clientes', 'INSERT', `Nuevo cliente: ${nombre} ${paterno}`],
                () => {}
            );
            res.json({ success: true, id: result.lastID });
        }
    );
});

app.put('/api/clientes/:id', (req, res) => {
    const { nombre, paterno, materno, fecha_nac, curp, rfc, telefono, correo, direccion } = req.body;
    db.run(
        `UPDATE clientes SET nombre=$1, paterno=$2, materno=$3, fecha_nac=$4, curp=$5, rfc=$6, telefono=$7, correo=$8, direccion=$9 WHERE id=$10`,
        [nombre, paterno, materno, fecha_nac, curp, rfc, telefono, correo, direccion, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`INSERT INTO auditoria (usuario, modulo, accion, detalle) VALUES ($1, $2, $3, $4)`,
                ['sistema', 'Clientes', 'UPDATE', `Cliente ID: ${req.params.id} modificado`],
                () => {}
            );
            res.json({ success: true });
        }
    );
});

// ─── RUTAS: PRÉSTAMOS ────────────────────────────────────────────────────────
app.get('/api/prestamos', (req, res) => {
    db.all(
        `SELECT p.*, c.nombre || ' ' || c.paterno AS cliente
         FROM prestamos p JOIN clientes c ON p.id_cliente = c.id
         ORDER BY p.id DESC`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.get('/api/prestamos/pendientes', (req, res) => {
    db.all(
        `SELECT p.*, c.nombre || ' ' || c.paterno AS cliente
         FROM prestamos p JOIN clientes c ON p.id_cliente = c.id
         WHERE p.estado = 'pendiente'`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.get('/api/prestamos/aprobados', (req, res) => {
    db.all(
        `SELECT p.*, c.nombre || ' ' || c.paterno AS cliente
         FROM prestamos p JOIN clientes c ON p.id_cliente = c.id
         WHERE p.estado = 'aprobado'`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.get('/api/prestamos/activos', (req, res) => {
    db.all(
        `SELECT p.*, c.nombre || ' ' || c.paterno AS cliente
         FROM prestamos p JOIN clientes c ON p.id_cliente = c.id
         WHERE p.estado = 'activo'`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/prestamos', (req, res) => {
    const { id_cliente, monto, plazo, tasa, pago_semanal } = req.body;
    db.run(
        `INSERT INTO prestamos (id_cliente, monto, plazo, tasa, pago_semanal) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [id_cliente, monto, plazo, tasa, pago_semanal],
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: result.lastID });
        }
    );
});

app.put('/api/prestamos/:id/aprobar', (req, res) => {
    db.run(
        `UPDATE prestamos SET estado='aprobado', fecha_aprobacion=CURRENT_TIMESTAMP WHERE id=$1`,
        [req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`INSERT INTO auditoria (usuario, modulo, accion, detalle) VALUES ($1, $2, $3, $4)`,
                ['analista', 'Préstamos', 'APROBAR', `Préstamo ID: ${req.params.id} aprobado`],
                () => {}
            );
            res.json({ success: true });
        }
    );
});

app.put('/api/prestamos/:id/rechazar', (req, res) => {
    const { motivo } = req.body;
    db.run(
        `UPDATE prestamos SET estado='rechazado', motivo_rechazo=$1 WHERE id=$2`,
        [motivo, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`INSERT INTO auditoria (usuario, modulo, accion, detalle) VALUES ($1, $2, $3, $4)`,
                ['analista', 'Préstamos', 'RECHAZAR', `Préstamo ID: ${req.params.id} - Motivo: ${motivo}`],
                () => {}
            );
            res.json({ success: true });
        }
    );
});

app.put('/api/prestamos/:id/desembolsar', (req, res) => {
    db.run(
        `UPDATE prestamos SET estado='activo' WHERE id=$1`,
        [req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`INSERT INTO auditoria (usuario, modulo, accion, detalle) VALUES ($1, $2, $3, $4)`,
                ['cajero', 'Caja', 'DESEMBOLSO', `Préstamo ID: ${req.params.id} desembolsado`],
                () => {}
            );
            res.json({ success: true });
        }
    );
});

// ─── RUTAS: PAGOS ────────────────────────────────────────────────────────────
app.get('/api/pagos/hoy', (req, res) => {
    db.all(
        `SELECT pg.*, c.nombre || ' ' || c.paterno AS cliente
         FROM pagos pg
         JOIN prestamos p ON pg.id_prestamo = p.id
         JOIN clientes c ON p.id_cliente = c.id
         WHERE pg.fecha_pago::date = CURRENT_DATE
         ORDER BY pg.id DESC`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/pagos', (req, res) => {
    const { id_prestamo, monto_pagado } = req.body;
    db.run(
        `INSERT INTO pagos (id_prestamo, monto_pagado) VALUES ($1, $2) RETURNING id`,
        [id_prestamo, monto_pagado],
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: result.lastID });
        }
    );
});

// ─── RUTAS: COBRANZA EN MORA ─────────────────────────────────────────────────
app.get('/api/mora', (req, res) => {
    db.all(
        `SELECT p.id, c.nombre || ' ' || c.paterno AS cliente, c.telefono,
                p.monto, p.pago_semanal, p.fecha_aprobacion,
                CAST(EXTRACT(EPOCH FROM (NOW() - p.fecha_aprobacion)) / 604800 AS INT) AS semanas_transcurridas,
                (SELECT COUNT(*) FROM pagos WHERE id_prestamo = p.id) AS pagos_realizados
         FROM prestamos p
         JOIN clientes c ON p.id_cliente = c.id
         WHERE p.estado = 'activo'`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const mora = rows.filter(r => r.pagos_realizados < r.semanas_transcurridas);
            mora.forEach(r => {
                r.semanas_atraso = r.semanas_transcurridas - r.pagos_realizados;
                r.multa = (r.semanas_atraso * r.pago_semanal * 0.05).toFixed(2);
            });
            res.json(mora);
        }
    );
});

// ─── RUTAS: AUDITORÍA ────────────────────────────────────────────────────────
app.get('/api/auditoria', (req, res) => {
    db.all(`SELECT * FROM auditoria ORDER BY id DESC LIMIT 200`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
    const data = {};
    db.get(`SELECT COUNT(*) as total FROM clientes`, [], (err, r) => {
        data.clientes = r?.total || 0;
        db.get(`SELECT COUNT(*) as total FROM prestamos WHERE estado='pendiente'`, [], (err, r) => {
            data.pendientes = r?.total || 0;
            db.get(`SELECT COUNT(*) as total FROM prestamos WHERE estado='activo'`, [], (err, r) => {
                data.activos = r?.total || 0;
                db.get(`SELECT COALESCE(SUM(monto_pagado),0) as total FROM pagos WHERE fecha_pago::date = CURRENT_DATE`, [], (err, r) => {
                    data.cobros_hoy = r?.total || 0;
                    res.json(data);
                });
            });
        });
    });
});

// =============================================================================
// ─── GENERACIÓN DE PDFS EN TIEMPO REAL CON EJS Y PUPPETEER ───────────────────
// =============================================================================

// 1. ENDPOINT: CONTRATO DE PRÉSTAMO
app.get('/api/prestamos/:id/contrato.pdf', (req, res) => {
    db.get(
        `SELECT p.*, 
                c.nombre || ' ' || c.paterno || ' ' || COALESCE(c.materno,'') AS cliente_nombre,
                c.curp, c.rfc, c.telefono, c.correo, c.direccion
         FROM prestamos p 
         JOIN clientes c ON p.id_cliente = c.id 
         WHERE p.id = $1`,
        [req.params.id],
        (err, p) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!p) return res.status(404).json({ error: 'Préstamo no encontrado' });

            const totalPagar = (p.pago_semanal * p.plazo).toFixed(2);
            const totalIntereses = (totalPagar - p.monto).toFixed(2);
            const folio = String(p.id).padStart(6, '0');

            createPdf(res, `Contrato_${folio}.pdf`, (doc) => {
                doc.fontSize(18).text('Contrato de Préstamo', { align: 'center' });
                doc.moveDown(0.5);
                doc.fontSize(10).text(`Folio: ${folio}`);
                doc.text(`Fecha: ${new Date().toLocaleDateString('es-MX')}`);
                doc.moveDown(0.5);
                doc.fontSize(12).text('Datos del cliente', { underline: true });
                doc.moveDown(0.2);
                doc.fontSize(10).text(`Cliente: ${p.cliente_nombre}`);
                doc.text(`CURP: ${p.curp}`);
                doc.text(`RFC: ${p.rfc}`);
                doc.text(`Teléfono: ${p.telefono}`);
                doc.text(`Correo: ${p.correo}`);
                doc.text(`Dirección: ${p.direccion}`);
                doc.moveDown(0.5);
                doc.fontSize(12).text('Detalles del préstamo', { underline: true });
                doc.moveDown(0.2);
                doc.fontSize(10).text(`Monto solicitado: $${Number(p.monto).toFixed(2)}`);
                doc.text(`Plazo: ${p.plazo} semanas`);
                doc.text(`Pago semanal: $${Number(p.pago_semanal).toFixed(2)}`);
                doc.text(`Tasa: ${Number(p.tasa).toFixed(2)}%`);
                doc.text(`Total a pagar: $${totalPagar}`);
                doc.text(`Intereses: $${totalIntereses}`);
                doc.text(`Estado: ${p.estado}`);
                doc.moveDown(0.5);
                doc.fontSize(10).text('Este contrato es un documento generado automáticamente para efectos de presentación.');
                doc.moveDown(1);
                doc.text('Firma del cliente: ________________________________');
                doc.moveDown(0.5);
                doc.text('Firma del representante: __________________________');
            });
        }
    );
});

// 2. ENDPOINT: RECIBO DE PAGO INDIVIDUAL
app.get('/api/pagos/:id/recibo.pdf', (req, res) => {
    db.get(
        `SELECT pg.id AS pago_id, pg.monto_pagado, pg.fecha_pago,
                p.id AS prestamo_id, p.monto AS monto_prestamo, p.pago_semanal, p.plazo,
                c.nombre || ' ' || c.paterno || ' ' || COALESCE(c.materno,'') AS cliente_nombre
         FROM pagos pg
         JOIN prestamos p ON pg.id_prestamo = p.id
         JOIN clientes c ON p.id_cliente = c.id
         WHERE pg.id = $1`,
        [req.params.id],
        (err, pagoInfo) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!pagoInfo) return res.status(404).json({ error: 'Registro de pago no encontrado' });

            db.get(
                `SELECT COALESCE(SUM(monto_pagado), 0) AS acumulado
                 FROM pagos 
                 WHERE id_prestamo = $1 AND id <= $2`,
                [pagoInfo.prestamo_id, pagoInfo.pago_id],
                (errSub, subRow) => {
                    if (errSub) return res.status(500).json({ error: errSub.message });

                    const totalPagadoHastaFecha = subRow.acumulado;
                    const totalDeudaCalculada = pagoInfo.pago_semanal * pagoInfo.plazo;
                    const saldoPendiente = Math.max(0, totalDeudaCalculada - totalPagadoHastaFecha).toFixed(2);

                    createPdf(res, `Recibo_Pago_${pagoInfo.pago_id}.pdf`, (doc) => {
                        doc.fontSize(18).text('Recibo de Pago', { align: 'center' });
                        doc.moveDown(0.5);
                        doc.fontSize(10).text(`Pago ID: ${pagoInfo.pago_id}`);
                        doc.text(`Fecha de pago: ${new Date(pagoInfo.fecha_pago).toLocaleString('es-MX')}`);
                        doc.text(`Cliente: ${pagoInfo.cliente_nombre}`);
                        doc.text(`Préstamo ID: ${pagoInfo.prestamo_id}`);
                        doc.moveDown(0.5);
                        doc.fontSize(12).text('Resumen de pago', { underline: true });
                        doc.moveDown(0.2);
                        doc.fontSize(10).text(`Monto pagado: $${Number(pagoInfo.monto_pagado).toFixed(2)}`);
                        doc.text(`Total pagado hasta la fecha: $${Number(totalPagadoHastaFecha).toFixed(2)}`);
                        doc.text(`Saldo pendiente: $${saldoPendiente}`);
                        doc.text(`Monto del préstamo: $${Number(pagoInfo.monto_prestamo).toFixed(2)}`);
                        doc.text(`Pago semanal: $${Number(pagoInfo.pago_semanal).toFixed(2)}`);
                        doc.text(`Plazo: ${pagoInfo.plazo} semanas`);
                        doc.moveDown(1);
                        doc.text('Gracias por su pago.', { align: 'center' });
                    });
                }
            );
        }
    );
});

// ─── INICIAR SERVIDOR ────────────────────────────────────────────────────────
app.get(/^(?!\/api).*/, (req, res) => {
    if (req.method === 'GET' && !path.extname(req.path)) {
        return res.sendFile(path.join(__dirname, 'index.html'));
    }
    res.status(404).json({ error: 'Endpoint no encontrado' });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`   Usuario por defecto: admin / admin123`);
});