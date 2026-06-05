//UTILIDADES GENERALES 
const fmt = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);

//DASHBOARD
if (document.getElementById('stat-clientes')) {
    fetch('/api/dashboard')
        .then(r => r.json())
        .then(data => {
            document.getElementById('stat-clientes').textContent = data.clientes;
            document.getElementById('stat-pendientes').textContent = data.pendientes;
            document.getElementById('stat-activos').textContent = data.activos;
            document.getElementById('stat-cobros').textContent = fmt(data.cobros_hoy);
        });
}

//DIRECTORIO DE CLIENTES
if (document.getElementById('tabla-clientes')) {
    fetch('/api/clientes')
        .then(r => r.json())
        .then(clientes => {
            const tbody = document.getElementById('tabla-clientes');
            if (!clientes.length) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No hay clientes registrados.</td></tr>`;
                return;
            }
            tbody.innerHTML = clientes.map(c => `
                <tr>
                    <td>${c.id}</td>
                    <td>${c.nombre} ${c.paterno} ${c.materno || ''}</td>
                    <td>${c.curp}</td>
                    <td>${c.telefono || '—'}</td>
                    <td>${fmt(c.saldo_pendiente || 0)}</td>
                    <td>
                        <button class="btn btn-secondary" style="padding:6px 12px;font-size:0.8rem;"
                            onclick="editarCliente(${c.id})">Editar</button>
                    </td>
                </tr>`).join('');
        });
}

function editarCliente(id) {
    window.location.href = `clientes_expediente.html?id=${id}`;
}

//FORMULARIO DE CLIENTE (ALTA Y EDICIÓN) 
if (document.getElementById('form-registro-cliente')) {
    const params = new URLSearchParams(window.location.search);
    const clienteId = params.get('id');

    if (clienteId) {
        fetch('/api/clientes')
            .then(r => r.json())
            .then(lista => {
                const c = lista.find(x => x.id == clienteId);
                if (!c) return;
                document.getElementById('nombre').value    = c.nombre;
                document.getElementById('paterno').value   = c.paterno;
                document.getElementById('materno').value   = c.materno || '';
                document.getElementById('fecha_nac').value = c.fecha_nac || '';
                document.getElementById('curp').value      = c.curp;
                document.getElementById('rfc').value       = c.rfc || '';
                document.getElementById('telefono').value  = c.telefono || '';
                document.getElementById('correo').value    = c.correo || '';
                document.getElementById('direccion').value = c.direccion || '';
            });
    }

    document.getElementById('form-registro-cliente').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
            nombre:    document.getElementById('nombre').value,
            paterno:   document.getElementById('paterno').value,
            materno:   document.getElementById('materno').value,
            fecha_nac: document.getElementById('fecha_nac').value,
            curp:      document.getElementById('curp').value.toUpperCase(),
            rfc:       document.getElementById('rfc').value.toUpperCase(),
            telefono:  document.getElementById('telefono').value,
            correo:    document.getElementById('correo').value,
            direccion: document.getElementById('direccion').value,
        };

        const url    = clienteId ? `/api/clientes/${clienteId}` : '/api/clientes';
        const method = clienteId ? 'PUT' : 'POST';

        const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (data.success) {
            alert(clienteId ? '✅ Cliente actualizado.' : '✅ Cliente registrado correctamente.');
            window.location.href = 'clientes_directorio.html';
        } else {
            alert('Error: ' + (data.error || 'Verifica los datos.'));
        }
    });
}

//SIMULADOR DE PRESTAMOS 
if (document.getElementById('form-simulador')) {
    fetch('/api/clientes')
        .then(r => r.json())
        .then(clientes => {
            const sel = document.getElementById('id_cliente');
            clientes.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = `${c.nombre} ${c.paterno} (${c.curp})`;
                sel.appendChild(opt);
            });
        });

    document.getElementById('form-simulador').addEventListener('submit', (e) => {
        e.preventDefault();
        const monto = parseFloat(document.getElementById('monto').value);
        const plazo = parseInt(document.getElementById('plazo').value);
        const tasa  = parseFloat(document.getElementById('tasa').value);

        const tasaSemanal  = tasa / 100 / 52;
        const pagoSemanal  = monto * (tasaSemanal * Math.pow(1 + tasaSemanal, plazo)) / (Math.pow(1 + tasaSemanal, plazo) - 1);
        let saldo = monto;
        let filas = '';

        for (let i = 1; i <= plazo; i++) {
            const interes  = saldo * tasaSemanal;
            const capital  = pagoSemanal - interes;
            saldo -= capital;
            filas += `<tr>
                <td>${i}</td>
                <td>${fmt(pagoSemanal)}</td>
                <td>${fmt(capital)}</td>
                <td>${fmt(interes)}</td>
                <td>${fmt(Math.max(0, saldo))}</td>
            </tr>`;
        }

        document.getElementById('tabla-cuerpo').innerHTML = filas;
        document.getElementById('contenedor-amortizacion').style.display = 'block';

        document.getElementById('btn-enviar-solicitud').onclick = async () => {
            const id_cliente = document.getElementById('id_cliente').value;
            if (!id_cliente) { alert('Selecciona un cliente.'); return; }
            const res  = await fetch('/api/prestamos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_cliente, monto, plazo, tasa, pago_semanal: pagoSemanal.toFixed(2) })
            });
            const data = await res.json();
            if (data.success) {
                alert('✅ Solicitud enviada a aprobación.');
                window.location.href = 'prestamos_aprobaciones.html';
            }
        };
    });
}

//APROBACIONES
if (document.getElementById('tabla-aprobaciones')) {
    cargarPendientes();
}

function cargarPendientes() {
    fetch('/api/prestamos/pendientes')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('tabla-aprobaciones');
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#94a3b8;">No hay solicitudes pendientes.</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map(p => `
                <tr>
                    <td>#${p.id}</td>
                    <td>${p.cliente}</td>
                    <td>${fmt(p.monto)}</td>
                    <td>${p.plazo} semanas</td>
                    <td>${p.tasa}%</td>
                    <td>
                        <button class="btn btn-primary" style="padding:6px 10px;font-size:0.8rem;margin-right:5px;"
                            onclick="aprobar(${p.id})">✅ Aprobar</button>
                        <button class="btn" style="padding:6px 10px;font-size:0.8rem;background:#ef4444;color:white;"
                            onclick="rechazar(${p.id})">❌ Rechazar</button>
                    </td>
                </tr>`).join('');
        });
}

async function aprobar(id) {
    const pdfWindow = window.open('', '_blank');
    const res = await fetch(`/api/prestamos/${id}/aprobar`, { method: 'PUT' });
    const data = await res.json();
    if (data.success) {
        pdfWindow.location.href = `/api/prestamos/${id}/contrato.pdf`;
        alert('✅ Préstamo aprobado. Se abrió el contrato en una pestaña nueva.');
        cargarPendientes();
    } else {
        pdfWindow.close();
        alert('❌ Error al aprobar el préstamo.');
    }
}

async function rechazar(id) {
    const motivo = prompt('Escribe el motivo del rechazo:');
    if (!motivo) return;
    await fetch(`/api/prestamos/${id}/rechazar`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo })
    });
    alert('Solicitud rechazada.');
    cargarPendientes();
}

//DESEMBOLSOS
if (document.getElementById('tabla-desembolsos')) {
    fetch('/api/prestamos/aprobados')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('tabla-desembolsos');
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#94a3b8;">Sin créditos pendientes de entrega.</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map(p => `
                <tr>
                    <td>#${p.id}</td>
                    <td>${p.cliente}</td>
                    <td>${fmt(p.monto)}</td>
                    <td>${p.fecha_aprobacion}</td>
                    <td>
                        <button class="btn btn-primary" style="padding:6px 12px;font-size:0.8rem;"
                            onclick="desembolsar(${p.id})">💵 Entregar Dinero</button>
                    </td>
                </tr>`).join('');
        });
}

async function desembolsar(id) {
    if (!confirm('¿Confirmas que el dinero ya fue entregado al cliente?')) return;
    await fetch(`/api/prestamos/${id}/desembolsar`, { method: 'PUT' });
    alert('✅ Crédito activado correctamente.');
    location.reload();
}

//PAGOS
if (document.getElementById('credito_id')) {
    fetch('/api/prestamos/activos')
        .then(r => r.json())
        .then(rows => {
            const sel = document.getElementById('credito_id');
            rows.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = `#${p.id} — ${p.cliente} (Cuota: ${fmt(p.pago_semanal)})`;
                sel.appendChild(opt);
            });
        });

    fetch('/api/pagos/hoy')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('tabla-ultimos-pagos');
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#94a3b8;">Sin pagos registrados hoy.</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map(p => `
                <tr>
                    <td>#${p.id}</td>
                    <td>#${p.id_prestamo}</td>
                    <td>${p.cliente}</td>
                    <td>${fmt(p.monto_pagado)}</td>
                    <td>${p.fecha_pago}</td>
                </tr>`).join('');
        });

    document.getElementById('form-pago').addEventListener('submit', async (e) => {
        e.preventDefault();
        const reciboWindow = window.open('', '_blank');
        const id_prestamo  = document.getElementById('credito_id').value;
        const monto_pagado = document.getElementById('monto_pago').value;
        const res  = await fetch('/api/pagos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id_prestamo, monto_pagado })
        });
        const data = await res.json();
        if (data.success) {
            reciboWindow.location.href = `/api/pagos/${data.id}/recibo.pdf`;
            alert(`✅ Pago registrado. Se abrió el recibo en una pestaña nueva.`);
            location.reload();
        } else {
            reciboWindow.close();
            alert('❌ Error al registrar el pago.');
        }
    });
}

//COBRANZA EN MORA
if (document.getElementById('tabla-mora')) {
    fetch('/api/mora')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('tabla-mora');
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#94a3b8;">🎉 No hay clientes en mora.</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map(r => `
                <tr>
                    <td>#${r.id}</td>
                    <td>${r.cliente}</td>
                    <td>${r.telefono || '—'}</td>
                    <td style="color:#ef4444;font-weight:600;">${r.semanas_atraso} sem.</td>
                    <td style="color:#ef4444;font-weight:600;">${fmt(r.multa)}</td>
                    <td><span style="background:#fef2f2;color:#ef4444;padding:4px 10px;border-radius:20px;font-size:0.8rem;">⚠️ En mora</span></td>
                </tr>`).join('');
        });
}

//AUDITORIA
if (document.getElementById('tabla-auditoria')) {
    fetch('/api/auditoria')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('tabla-auditoria');
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#94a3b8;">Sin registros de auditoría.</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map(r => `
                <tr>
                    <td>${r.fecha}</td>
                    <td>${r.usuario}</td>
                    <td>${r.modulo}</td>
                    <td>${r.accion}</td>
                    <td style="color:#64748b;font-size:0.85rem;">${r.detalle}</td>
                </tr>`).join('');
        });
}