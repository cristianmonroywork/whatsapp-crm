# Arquitectura y contrato de datos

## Modelo multiusuario

`auth.users → profiles → memberships ← businesses`. Una persona puede participar en varios negocios y un negocio admite varias personas; los roles no son un módulo de empleados. La API valida al usuario con Auth; SQL verifica que exista su membresía. El canal WhatsApp resuelve `(phone_number_id, sender_id)` a una única membresía administrada.

Cada fila financiera tiene `business_id`; las referencias entre contactos, movimientos, mensajes y auditoría usan claves compuestas `(business_id, id)`. Así no puede vincularse un pago con una cuenta de otro negocio por un ID ajeno. RLS limita las lecturas y no permite escrituras del cliente. Las funciones con privilegios de servidor revocan EXECUTE de PUBLIC/anon/authenticated; sólo service_role puede invocarlas.

| Entidad | Propósito |
|---|---|
| businesses | Nombre, moneda MXN, zona IANA validada. |
| profiles / memberships | Identidad de Auth y autorización por negocio. |
| channel_bindings | Remitente autorizado y número receptor de Meta. |
| contacts | Nombre exacto normalizado por negocio; sin fuzzy matching. |
| movements | Libro: sale, expense, receivable y payment. Enteros en centavos, fecha de negocio, versión y anulación. |
| accounts_receivable | Vista de deudas activas con saldo calculado: importe menos pagos activos. |
| payments | Vista de movimientos de abono con referencia a cuenta. |
| messages | Identificador externo, huella de contenido, actor, canal, original, comando, medio y respuesta persistida. |
| pending_actions | Mutación propuesta, objetivo/version, código, actor/canal y caducidad. |
| movement_audit | Snapshot anterior y posterior, acción, actor y mensaje causante. |
| outbox | Texto pendiente/en envío/enviado, lease, intentos e ID de Meta. |
| request_limits | Cuota persistente por usuario antes de invocar IA, 30 mensajes/minuto. |

Las cuentas y pagos son tipos del mismo libro, expuestos como vistas con `security_invoker`; no son un segundo conjunto de tablas que pueda divergir. Deuda abierta y venta son conceptos distintos. El schema permite crecer sin introducir un CRM visual.

## Operación atómica

1. API autoriza y busca un recibo por negocio/canal/ID.
2. Si ya existe, exige mismo actor y huella; devuelve la respuesta anterior sin gastar IA.
3. Si es nuevo, consume cuota y extrae intención (o reconoce confirmación literal).
4. JS valida la estructura, convierte pesos a centavos y multiplica precio unitario cuando corresponde.
5. `process_command` bloquea la fila del negocio con `FOR UPDATE` y vuelve a comprobar el recibo. Esto cierra la carrera entre dos peticiones nuevas con el mismo ID.
6. En una sola transacción escribe mensaje, movimiento, auditoría y resultado. Cualquier excepción revierte todo.
7. SQL suma importes activos y resuelve fechas en la zona del negocio. Los saldos no se guardan como acumuladores editables.
8. El canal formatea exclusivamente el resultado SQL. El envío a Meta no forma parte de la transacción financiera.

Una misma frase enviada conscientemente dos veces con IDs distintos puede representar dos operaciones; no se deduplica por texto. Si una respuesta HTTP se pierde, el chat mantiene el ID al reintentar durante esa sesión de página. Recargar antes de resolver una respuesta incierta pierde ese contexto: consultar el total antes de volver a registrar. En WhatsApp el proveedor conserva su `wamid` para reintentos.

## Confirmaciones y orden

Sólo el último movimiento activo creado por ese actor en ese negocio se propone como objetivo; la propuesta lo nombra con importe, fecha y descripción. Confirmar nunca vuelve a buscar “el último”: modifica el ID y versión fijados. Una venta nueva intermedia no cambia el objetivo. Una versión distinta invalida la propuesta. Los pagos relacionados se vuelven a comprobar al confirmar, dentro del mismo bloqueo de negocio.

Los mensajes entrantes no llevan un reloj confiable para decidir el orden contable. Se usa orden de confirmación en BD, y “hoy” es la fecha de procesamiento del servidor en la zona del negocio. Un webhook que sólo llega por primera vez después de medianoche se registra en ese nuevo día; el usuario puede expresar la fecha del movimiento de forma explícita. Un reintento de un mensaje ya guardado devuelve siempre su resultado original, aunque cambie el día.

## Extensión para voz

El contrato de entrada del servicio admite `media`. Hoy el adaptador conserva el ID de audio y no llama al intérprete sobre contenido inexistente. Al incorporar transcripción, el adaptador completará `text` y `media.transcribed=true`, manteniendo el ID externo original. No debe crear una nueva operación por cada reintento de descarga/transcripción. Aún no hay transcriptor ni reproducción multimedia.

## Límites operativos del sprint

- Sin cola de entrada duradera; procesamiento síncrono, adecuado para validar pocos vendedores, no certificado para volumen alto.
- Sin refresh de sesión, selector de deuda para múltiples cuentas, edición de fechas/cliente ni restauración conversacional de anulaciones.
- Sin clasificación fiscal, utilidad, stock, pedidos detallados, abonos a venta en una sola frase ni recordatorios.
- AI puede interpretar mal aun con schema válido. Confirmaciones protegen cambios y anulaciones; para nuevas ventas simples se aplica directamente el dato estructurado y se devuelve el importe para revisión del vendedor.
- El historial de chat visible se reinicia al recargar; la información financiera y el registro de mensajes persisten.
- Auth, correo de acceso, latencia, roles nativos y concurrencia real requieren validación en el Supabase nuevo.
