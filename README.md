# Cuenta Clara — MVP Sprint 1.5

Asistente de cuentas para micronegocios en México. Canal previsto: WhatsApp; incluye un chat pequeño para probar el mismo servicio. Proyecto nuevo e independiente, sin vínculo a recursos ni proyectos de otros clientes.

**Estado de entrega:** aplicación, API, migración y pruebas implementadas. El flujo «Vendí 3 playeras en $900» → guardar → «¿cuánto vendí hoy?» → **$900.00 MXN** está verificado con PostgreSQL local y el intérprete de demostración. El adaptador de interpretación ya usa Gemini Structured Outputs. Los adaptadores remotos tienen pruebas simuladas; la validación real requiere configurar los recursos nuevos y exclusivos de Cuenta Clara. No confundir la demo con esa validación pendiente.

## Probar ahora

Requisitos: Node.js 22.9+ o 24 y npm.

```sh
npm ci
npm test
npm run check
npm run dev
```

Abre http://127.0.0.1:3000. Sin archivo de entorno arranca una **demo local explícita**, limitada a los ejemplos visibles. Sus registros se guardan en `.local/db` mediante PGlite (PostgreSQL), persisten al reiniciar y nunca salen a servicios externos. La demo no está habilitada en Vercel. No ejecutar dos servidores contra la misma carpeta local.

Prueba, en este orden:

1. `Vendí 3 playeras en $900`
2. `¿Cuánto vendí hoy?` → Ventas: $900.00 MXN si el negocio estaba vacío.
3. `Gasté $180 de gasolina`
4. `Corrige el último a $150` → solicita confirmación del gasto.
5. Copia `CONFIRMAR <código>` de la respuesta → gasto de $150.
6. `Elimina el último` → confirma con el **nuevo** código → anulación con historial.
7. `Pedro me debe $600`
8. `Pedro ya me pagó $300`
9. `¿Cuánto me deben?` → $300.00 MXN.

La demo conserva lo registrado: enviar de nuevo la misma venta intencionalmente genera otra venta. Sólo se deduplica un **mismo identificador de mensaje**, no frases idénticas con identificadores distintos.

## Arquitectura

```text
WhatsApp (firma HMAC + remitente vinculado)   Chat (Supabase Auth)
                     \                     /
                       API Node en Vercel
                               |
               Identidad, autorización, cuota e idempotencia
                               |
          Gemini Generate Content → intención + datos estructurados
                               |
             Validación y conversión exacta a centavos (JS)
                               |
        Supabase RPC: transacción, bloqueo por negocio, SQL
            mensajes + movimientos + auditoría + respuesta
                               |
                 Texto determinista → chat / Meta
```

- `src/interpret.js`: contrato JSON, prompt e integración con Gemini; intérprete local separado.
- `src/domain.js`: importes, validación, confirmación literal y respuestas. La IA no emite códigos de confirmación ni consulta la BD.
- `src/service.js`: flujo común entre canales; verifica membresía antes de consultar recibos o interpretar.
- `src/store.js`: acceso servidor a Supabase REST/RPC. Cero dependencias de ejecución en producción: usa `fetch` nativo.
- `supabase/migrations/001_initial.sql`: reglas financieras y transacciones.
- `src/whatsapp.js`: validación HMAC, procesamiento de todos los mensajes del lote, envío y reintentos con outbox.
- `api/index.js`: sesiones, chat y webhook. No expone claves del servidor.
- `public/`: chat accesible y adaptable; sin inventario ni CRM visual.
- `scripts/local-store.js`: sólo desarrollo y pruebas; misma migración SQL con sustitutos locales de los roles/Auth de Supabase.

Vercel publica archivos estáticos y una función Node. `NODEJS_HELPERS=0` preserva el cuerpo HTTP original para verificar la firma. No se necesita Next.js para este sprint. No hay estado financiero en memoria de la función.

## Reglas del MVP

| Concepto | Regla |
|---|---|
| Dinero | MXN, entero en centavos, positivo; máximo $1,000,000,000 por movimiento. Sin `float` para sumar dinero. |
| Precio unitario | IA devuelve precio y cantidad por separado; JS multiplica centavos enteros. “3 playeras en $900” son **$900 en total**. |
| Ventas / gastos | Se registran por separado. El resumen no se presenta como utilidad neta ni contabilidad fiscal. |
| Cuentas por cobrar | `Pedro me debe $600` abre una deuda; **no crea una venta**. |
| Pagos | Reducen una cuenta abierta, no aumentan las ventas. No se acepta sobrepago. |
| Cliente | Coincidencia por nombre normalizado exacto, sin distinguir mayúsculas; sin coincidencia difusa. Usar nombres distintivos para homónimos. |
| Varias deudas del mismo cliente | El pago se rechaza con explicación si no identifica una única cuenta abierta. Selección de cuenta o distribución de pagos queda para otro sprint. |
| Fechas | `today`/`yesterday` se calculan en SQL con la zona IANA del negocio. Fechas explícitas pasan validación; futuras no soportadas. Semana empieza lunes. |
| Último movimiento | Último no anulado del **usuario actual dentro del negocio**, por secuencia de registro. No “último de todos los usuarios”. |
| Correcciones | Sólo importe del último movimiento; primero se fija ID, versión, importe anterior y nuevo. Código por usuario/canal; caduca en 10 minutos. |
| Anulaciones | Siempre confirmadas, nunca borrado físico. Una cuenta con pagos no se anula ni se reduce por debajo de lo pagado. |
| Confirmación | Sólo `CONFIRMAR <código>` exacto o `CANCELAR`; “sí” no autoriza una mutación. Una petición nueva reemplaza la anterior del mismo canal. |
| Ambigüedad | Sin importe, varios movimientos, venta + fiado/pago combinados, moneda distinta o fecha no soportada → pedir reformular, sin movimiento. |
| Historial | Mensaje original, comando normalizado, respuesta, actor, origen y snapshots antes/después. No se usa memoria del modelo como registro. |

Para una venta fiada en este sprint, registrar la venta y la deuda en **dos mensajes explícitos**. Un pago posterior sólo abona a la deuda. La app no conoce el efectivo recibido por una venta si no se registra una cuenta; el total de ventas no debe interpretarse como caja. No hay inventarios, SAT, facturas, empleados, recordatorios automáticos ni reportes de utilidad.

## Configurar Supabase nuevo

1. Identifica por nombre e ID el **proyecto Supabase nuevo y exclusivo de Cuenta Clara**. Verifica su cuenta antes de ejecutar SQL. No selecciones uno existente de clientes o producción.
2. En su SQL Editor ejecuta una sola vez `supabase/migrations/001_initial.sql`. Está diseñada para proyecto vacío; no modifica esquemas preexistentes de clientes.
3. En Authentication crea un usuario de piloto con correo y contraseña; para prueba usa una cuenta confirmada. El alta pública no forma parte de esta app.
4. Copia su UUID y ejecuta `supabase/onboard.example.sql` tras sustituir el marcador. Genera un negocio nuevo y su membresía. Conserva el UUID mostrado.
5. Copia `.env.example` a `.env.local`; configura `APP_MODE=live`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` y `GEMINI_MODEL`.
6. Inicia `npm run dev`, entra con ese usuario y repite el flujo de $900. Comprueba los registros en `messages`, `movements` y `movement_audit`.

RLS está habilitado en todas las tablas. Los clientes autenticados sólo pueden leer sus negocios/movimientos/contactos; no pueden escribir directamente ni ejecutar RPC privilegiadas. La API valida el token con Supabase Auth y determina el actor en el servidor. La selección de negocio del navegador no da autorización: se verifica la membresía nuevamente en SQL.

La `service_role` es **sólo servidor**. Nunca uses prefijos públicos ni la pegues en el navegador o conversación. Una sesión expira en hasta una hora; en este sprint hay nuevo inicio de sesión, no renovación automática.

## Variables de entorno

| Variable | Uso |
|---|---|
| `APP_MODE` | `demo` local; `live` para Supabase + Gemini. Vercel rechaza `demo`. |
| `SUPABASE_URL` | URL del proyecto nuevo. |
| `SUPABASE_ANON_KEY` | Clave pública/anon del proyecto, usada por el proxy de Auth. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio del proyecto; acceso exclusivo del servidor. |
| `GEMINI_API_KEY` | Clave del proyecto Gemini para este piloto. |
| `GEMINI_MODEL` | Modelo con Structured Outputs; valor inicial `gemini-3.5-flash-lite`, modificable. |
| `PORT` | Puerto local; 3000 por defecto. |
| `NODEJS_HELPERS` | `0` en Vercel, incluido en `vercel.json`; verificar también la configuración del proyecto. |
| `WHATSAPP_ENABLED` | `false` hasta completar configuración y prueba con Meta. |
| `WHATSAPP_APP_SECRET` | Secreto de la app Meta para HMAC-SHA256. |
| `WHATSAPP_VERIFY_TOKEN` | Token aleatorio propio para el handshake del webhook. |
| `WHATSAPP_ACCESS_TOKEN` | Token Meta con acceso al número configurado. |
| `WHATSAPP_GRAPH_VERSION` | Versión Graph habilitada en tu app, formato `vNN.N`; no se adivina ni fija una versión obsoleta. |
| `TEST_USER_ID` | UUID de usuario Auth exclusivo de pruebas; sólo smoke real. |
| `SUPABASE_PROJECT_REF_CONFIRM` | Referencia exacta del proyecto aislado que se autoriza a probar. |
| `ALLOW_LIVE_SMOKE` | `isolated-project` activa explícitamente la prueba real; vacío por defecto. |
| `DEPLOYMENT_URL` / `VERCEL_PROJECT_DOMAIN_CONFIRM` | URL HTTPS y hostname exacto del despliegue nuevo. Deben coincidir. |
| `DEPLOY_BUSINESS_ID` / `DEPLOY_BUSINESS_NAME_CONFIRM` | Negocio piloto vacío y su nombre exacto para la prueba desplegada. |
| `TEST_EMAIL` / `TEST_PASSWORD` | Acceso del usuario piloto introducido directamente en `.env.local` ignorado por Git; nunca en comandos, commits ni respuestas. |
| `ALLOW_DEPLOY_SMOKE` | `isolated-project` activa la prueba HTTP del despliegue nuevo; vacío por defecto. |

El intérprete envía únicamente el mensaje a Gemini y no envía todo el libro del negocio. Esto no sustituye la configuración y políticas de retención del proveedor. Los mensajes sí se conservan en Supabase para trazabilidad. Los logs de la API sólo contienen categoría y estado, no mensajes ni secretos.

## Prueba real y despliegue Vercel

Con `GEMINI_API_KEY` configurada en `.env.local`, verifica primero la interpretación real sin escribir datos:

```sh
npm run test:gemini
```

Con la migración y las demás variables configuradas en el proyecto Supabase aislado:

```sh
npm run test:live
```

La prueba **crea un negocio de prueba nuevo** para `TEST_USER_ID`, conserva sus datos para inspección y verifica Gemini → Supabase → consulta de $900 y reintento sin duplicación. Consulta directamente `messages`, `movements` y `movement_audit` antes de declarar éxito. No borra ni limpia libros existentes. `SUPABASE_PROJECT_REF_CONFIRM` debe coincidir con el host de `SUPABASE_URL`.

Para publicar:

1. Verifica la URL y el propietario del **repositorio GitHub nuevo de Cuenta Clara**. Sube exclusivamente esta carpeta. No uses repositorios ni enlaces `.vercel` de clientes.
2. Verifica la identidad de la **cuenta Vercel nueva**. Importa ese repositorio como **proyecto nuevo** en esa cuenta. Framework: Other; Node 24; salida: `public`; instalación `npm ci`; no requiere compilación del frontend.
3. Configura las variables del proyecto nuevo con `APP_MODE=live`. La función vive en `api/index.js`; `vercel.json` contiene las rutas.
4. Mantén protección de acceso en la preview mientras validas el chat. Si Meta requiere acceso público al webhook, habilítalo deliberadamente para ese endpoint/proyecto de piloto y verifica su firma antes de conectar el número.
5. Prueba inicio de sesión, venta, consulta, confirmación y reintento en la URL de preview. Comprueba que ninguna ruta permite operar sin sesión o remitente vinculado.

Para la prueba HTTP automatizada, configura las variables `DEPLOY*`, `TEST_EMAIL`, `TEST_PASSWORD` y `ALLOW_DEPLOY_SMOKE=isolated-project` directamente en `.env.local` (archivo ignorado por Git), con un negocio piloto nuevo y vacío. Después ejecuta:

```sh
npm run test:deployment
```

El script verifica el hostname HTTPS, la identidad del negocio, el inicio de sesión, la venta de $900, el reintento con el mismo ID y la consulta de $900. Genera un movimiento real en ese negocio de prueba; no lo elimina.

## Conectar WhatsApp después

El código está preparado, pero **no hay número conectado ni mensajes enviados a personas reales**.

1. Crea/selecciona la app Meta destinada exclusivamente a este MVP y habilita WhatsApp Business Platform. Empieza con su número y destinatarios de prueba.
2. Configura secreto de app, token de acceso, token de verificación y la versión Graph de tu app en el proyecto Vercel nuevo.
3. Inserta un vínculo administrado en `channel_bindings` entre `phone_number_id` (número receptor de Meta), `sender_id` (WhatsApp ID del vendedor), negocio y usuario. El servidor jamás acepta el negocio que diga un mensaje; deriva la identidad de este vínculo. Un remitente no se autoinscribe.
4. Activa `WHATSAPP_ENABLED=true`; configura callback `https://TU-PROYECTO.vercel.app/api/whatsapp` y el mismo verify token. Suscribe eventos `messages`.
5. Envía desde el vendedor autorizado `Vendí 3 playeras en $900` y después `¿Cuánto vendí hoy?`. Revisa `messages`, `movements`, `outbox` y auditoría. Reenvía un webhook de prueba con el mismo `wamid`: no debe registrar dos ventas.
6. Sólo tras validar el número de prueba, completa los requisitos de Meta para un número real y su token de operación. Este sprint sólo responde a mensajes entrantes; no inicia campañas ni cobros a clientes.

La recepción verifica HMAC del cuerpo original, ignora estados de entrega como movimientos y recorre todos los mensajes del lote. Los números no vinculados no se procesan. Ante fallo de interpretación, BD o envío se devuelve error para permitir el reintento del proveedor.

**Entrega y límites:** operaciones financieras y respuestas se guardan juntas en una transacción. El outbox se crea después y se recupera al reintentar el mismo webhook. Una lease evita envíos simultáneos; si Meta acepta un envío pero la confirmación se pierde, podría repetirse el **texto**, nunca el movimiento. No se promete entrega exactamente una vez a un servicio externo. El piloto procesa sincrónicamente dentro del límite de Vercel; antes de escalar, añadir cola de entrada persistente, worker y recuperación programada de outbox. No hay cron ni worker duradero en este sprint. Los reintentos de Meta son finitos; monitorizar filas pendientes durante el piloto.

## Notas de voz preparadas

`messages.media` conserva tipo e identificador de medio; el servicio acepta texto transcrito con su procedencia. Audio entrante sin transcripción no genera movimientos. Próximo adaptador: descargar desde Meta en servidor, validar MIME/tamaño/duración, transcribir, registrar procedencia y pasar el texto por **el mismo** intérprete, validación y transacción. No se incluye captura, descarga ni transcripción de audio en este sprint.

## Pruebas y límites de verificación

`npm test` ejecuta PostgreSQL local real vía PGlite, no un ledger falso de objetos JS: migración, reglas, SQL y RLS. Prueba ventas/gastos, centavos, consulta, edición/anulación, pagos, sobrepago, duplicados, aislamiento, permisos, fechas, códigos, rollback, adaptadores y HTTP. Las peticiones concurrentes se prueban sobre una instancia local; PGlite serializa su conexión, así que no sustituye una prueba de carga multiconexión en Supabase. El bloqueo `FOR UPDATE` por negocio implementa la exclusión en PostgreSQL servidor.

Ver [docs/VALIDACION.md](docs/VALIDACION.md) y [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Un fallo de Gemini nunca cambia silenciosamente al intérprete demo.

## Referencias de implementación

- [Gemini: Structured Outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output): contrato de salida JSON Schema en Generate Content.
- [Supabase: Database Functions](https://supabase.com/docs/guides/database/functions): funciones Postgres y permisos.
- [Vercel: Node.js avanzado](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration): función Node y desactivación de helpers para cuerpo original.
- [Meta: verificación de webhooks en su SDK](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/): firma y handshake. Se usa HTTP directo; no se depende del SDK archivado.
