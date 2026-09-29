# Cuenta Clara — MVP Sprint 5.5

Asistente de cuentas para micronegocios en México. Canal previsto: WhatsApp; incluye un chat pequeño para probar el mismo servicio. Proyecto nuevo e independiente, sin vínculo a recursos ni proyectos de otros clientes.

**Estado:** texto y notas de voz usan el mismo servicio financiero; permiten registrar lotes y consultar cifras reales del negocio en lenguaje natural. Sprint 5.5 añade alta por invitación, métricas y operación de 3–5 pilotos. La integración Meta sigue pendiente.

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
2. `¿Cuánto vendí hoy?` → $900.00 si el negocio estaba vacío.
3. `Gasté $180 de gasolina`
4. `Corrige el último a $150` → solicita confirmación del gasto.
5. Copia `CONFIRMAR <código>` de la respuesta → gasto de $150.
6. `Elimina el último` → confirma con el **nuevo** código → anulación con historial.
7. `Pedro me debe $600`
8. `Pedro ya me pagó $300`
9. `¿Cuánto me deben?` → $300.00 MXN.
10. `¿Quién me debe?` → Pedro $300.00.
11. `¿Cómo va mi negocio?` → resumen breve de hoy.

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
       Lista ordenada → validación y centavos exactos (JS)
                               |
      Supabase RPC por negocio autorizado y zona IANA
       escritura: lote + auditoría / lectura: cifras SQL
                               |
          Respuesta determinista → chat / Meta
```

- `src/interpret.js`: contrato JSON, prompt e integración con Gemini; intérprete local separado.
- `src/domain.js`: importes, validación, confirmación literal y respuestas. La IA no emite códigos de confirmación ni consulta la BD.
- `src/service.js`: flujo común entre canales; verifica membresía antes de consultar recibos o interpretar.
- `src/store.js`: acceso servidor a Supabase REST/RPC.
- `src/voice.js`: validación de bytes, formato y duración; adaptador de transcripción Gemini separado del intérprete financiero.
- `supabase/migrations/001_initial.sql`: reglas financieras originales; `002_batches.sql`: lotes; `003_queries.sql`: consultas; `004_pilot.sql`: alta, métricas, límites, operador y desactivación.
- `src/whatsapp.js`: validación HMAC, procesamiento de todos los mensajes del lote, envío y reintentos con outbox.
- `api/index.js`: sesiones, chat y webhook. No expone claves del servidor.
- `api/audio`: acepta un archivo binario autenticado, comprueba membresía e idempotencia y entrega sólo su transcripción al servicio común.
- `public/`: chat accesible y adaptable; sin inventario ni CRM visual.
- `scripts/local-store.js`: sólo desarrollo y pruebas; misma migración SQL con sustitutos locales de los roles/Auth de Supabase.

Vercel publica archivos estáticos y una función Node. `NODEJS_HELPERS=0` preserva el cuerpo HTTP original para verificar la firma. No se necesita Next.js para este sprint. No hay estado financiero en memoria de la función.

## Alta y operación del piloto (Sprint 5.5)

El operador comparte la URL de la PWA y un código de invitación con 3–5 vendedores. Cada vendedor pulsa **Crear cuenta piloto**, usa su correo y una contraseña de al menos 10 caracteres, confirma su correo si Supabase lo solicita, inicia sesión y crea su negocio. Puede poner un nombre comercial o aceptar «Mi negocio» y escoger una zona horaria IANA de México. La API obtiene el usuario desde la sesión de Supabase Auth, crea perfil, negocio `is_pilot=true`, membresía `owner` y eventos iniciales en una sola transacción SQL. No se necesita SQL por vendedor. Un usuario no puede crear dos negocios piloto activos con este flujo. Una cuenta comercial futura no tendrá `is_pilot`; las métricas y la limpieza del piloto se filtran por ese indicador.

Para habilitar altas en el proyecto aislado: aplica `004_pilot.sql`, configura `PILOT_SIGNUP_ENABLED=true` y un `PILOT_INVITE_CODE` largo y aleatorio **sólo** en variables seguras de Vercel y vuelve a desplegar. Configura en Supabase Auth la URL del deployment piloto para confirmación de correo. El código de invitación no se guarda en el navegador ni en Supabase. Las sesiones usan cookie HttpOnly, SameSite=Strict y Secure en Vercel. Todas las acciones financieras vuelven a verificar la membresía en servidor y SQL; `business_id` del navegador por sí solo no autoriza nada.

El panel `/admin.html` sólo entrega datos mediante `/api/admin/pilots` si el usuario autenticado figura en `pilot_operators`. Ésta es una designación **única del operador**, no un alta manual por vendedor. Después de la migración, inserta el UUID del usuario operador ya confirmado en `pilot_operators` dentro del proyecto Cuenta Clara; no añadas otros usuarios por defecto. La tabla muestra negocios piloto, usuario, alta, último acceso, mensajes, operaciones, consultas, voz, errores y sesiones activas (actividad en los últimos 15 minutos). No muestra importes ni contenido de mensajes. Los eventos `signup_completed`, `business_created`, `message_text_sent`, `message_audio_sent`, `transaction_created`, `query_executed`, `ambiguity_returned`, `error_returned`, `correction_requested`, `correction_confirmed`, `deletion_confirmed`, `session_started` y `pilot_deactivated` conservan usuario, negocio, fecha y tipo; `error_returned` añade sólo categoría de error. Las operaciones de un lote producen eventos separados. Los eventos del mismo mensaje no se repiten al reintentarlo.

El operador puede pulsar **Desactivar** en el panel. Debe escribir el nombre exacto del negocio y la frase `DESACTIVAR PILOTO`. La función SQL exige además que sea operador y que el destino sea un piloto activo; deja `is_active=false` y registra `pilot_deactivated`. Desde entonces el vendedor no puede verlo ni registrar o consultar datos, incluso si manipula el ID. **La desactivación es reversible a nivel de datos y conserva mensajes, transcripciones, movimientos y auditoría** para investigar el piloto. La eliminación definitiva requiere un procedimiento posterior controlado; la página `/privacy.html` indica al vendedor que la solicite al operador que lo invitó. No se ejecuta un borrado físico automático.

Límites por defecto: 30 mensajes por minuto por usuario y 250 por día local del negocio; configurables con `PILOT_MESSAGES_PER_MINUTE` y `PILOT_MESSAGES_PER_DAY`. Se mantienen los límites de 3 MB y 60 segundos por audio y 8 operaciones por lote. Los reintentos con el mismo ID son idempotentes y no vuelven a consumir cuota. Un negocio vacío responde, por ejemplo, «Aún no tienes ventas registradas esta semana». Los errores de sesión, cuota, audio y servicio se presentan en lenguaje simple. Los logs sólo incluyen endpoint, estado, categoría, fecha e IDs internos cuando existen; nunca contenido, audio, contraseña o claves.

Antes de este sprint se comprobó una grabación real desde la web piloto: se transcribió «Gasté 35 de gasolina», generó un gasto de $35 y la consulta posterior mostró $235 de gastos acumulados en ese negocio de prueba. El usuario detectó que la vista previa no se reproducía. El motivo era la política CSP de Vercel: bloqueaba las URL locales `blob:` del elemento de audio. La configuración permite ahora `blob:` sólo en `media-src`. La interfaz también crea en memoria una vista previa **WAV PCM** mientras graba y conserva el formato comprimido para enviarlo. El WAV sólo vive en el navegador hasta enviar o cancelar; no se sube ni almacena. Debe repetirse la prueba de **▶ Escuchar** en la versión desplegada para confirmar la corrección.

## Reglas del MVP

| Concepto | Regla |
|---|---|
| Dinero | MXN, entero en centavos, positivo; máximo $1,000,000,000 por movimiento. Sin `float` para sumar dinero. |
| Precio unitario | IA devuelve precio y cantidad por separado; JS multiplica centavos enteros. “3 playeras en $900” son **$900 en total**. |
| Lotes | De 2 a 8 operaciones claras por mensaje. Si una es ambigua o inválida, no se registra ninguna; se pide aclaración. Un mensaje tiene un solo identificador idempotente. |
| Ventas / gastos | Se registran por separado. El resumen no se presenta como utilidad neta ni contabilidad fiscal. |
| Cuentas por cobrar | `Pedro me debe $600` abre una deuda; **no crea una venta**. |
| Pagos | Reducen una cuenta abierta, no aumentan las ventas. No se acepta sobrepago. |
| Venta fiada | Venta y cuenta por cobrar son dos movimientos del mismo lote. Un abono recibido al vender se guarda como componente de esa venta; no se aplica de nuevo como pago a la deuda. |
| Cliente | Coincidencia por nombre normalizado exacto, sin distinguir mayúsculas; sin coincidencia difusa. Usar nombres distintivos para homónimos. |
| Varias deudas del mismo cliente | El pago se rechaza con explicación si no identifica una única cuenta abierta. Selección de cuenta o distribución de pagos queda para otro sprint. |
| Fechas | `today`/`yesterday` se calculan en SQL con la zona IANA del negocio. Fechas explícitas pasan validación; futuras no soportadas. Semana empieza lunes. |
| Último movimiento | Último no anulado del **usuario actual dentro del negocio**, por secuencia de registro. No “último de todos los usuarios”. |
| Correcciones | Sólo importe del último movimiento de un mensaje individual; primero se fija ID, versión, importe anterior y nuevo. Si el último movimiento pertenece a un lote, se pide identificar la operación. Código por usuario/canal; caduca en 10 minutos. |
| Anulaciones | Siempre confirmadas, nunca borrado físico. Una cuenta con pagos no se anula ni se reduce por debajo de lo pagado. |
| Confirmación | Sólo `CONFIRMAR <código>` exacto o `CANCELAR`; “sí” no autoriza una mutación. Una petición nueva reemplaza la anterior del mismo canal. |
| Ambigüedad | Importes aproximados, referencias vagas, componentes incompatibles, moneda distinta o fecha no soportada → pedir reformular; ningún movimiento del lote se guarda. |
| Historial | Mensaje original, comando normalizado, respuesta, actor, origen y snapshots antes/después. No se usa memoria del modelo como registro. |

## Consultas y resúmenes de Sprint 5

Gemini sólo devuelve intención, periodo, métrica solicitada y fechas explícitas cuando el usuario las da. `process_financial_query` verifica `business_id` y membresía, toma la zona horaria IANA del negocio y lee movimientos y cuentas por cobrar. Excluye movimientos anulados. La respuesta se arma en `src/domain.js` a partir de esas cifras; Gemini no recibe el libro, no calcula totales, no consulta otros negocios y no escribe en la base. Texto y audio usan este mismo camino. Las consultas quedan en `messages` con identificador idempotente y respuesta guardada.

| Pregunta | Cálculo y respuesta |
|---|---|
| “¿Cuánto vendí/gasté hoy, ayer, esta semana o mes pasado?” | Suma únicamente ventas o gastos no anulados del periodo solicitado. “Esta semana” empieza el lunes. |
| “¿Cuánto me deben?” | Suma saldos positivos de cuentas abiertas: deuda original menos pagos no anulados. Puede filtrarse por nombre exacto. |
| “¿Quién me debe?” | Agrupa saldos pendientes por contacto; no muestra cuentas pagadas. |
| “¿Cómo me fue esta semana?” | Ventas, gastos registrados, saldo por cobrar, cobros si existen, número de movimientos, mejor día de ventas y comparación con semana anterior. No equivale a utilidad. |
| “¿Vendí más que la semana pasada?” | Muestra ventas de ambos periodos, diferencia absoluta y porcentaje cuando el anterior es mayor que cero. Si el anterior es cero, no se presenta porcentaje. |
| “¿Cuál fue mi mejor día?” | Agrupa ventas por fecha registrada; sin periodo explícito revisa el historial desde 2000. Si varios días empatan, enumera todos en orden de fecha. |
| “¿Cómo va mi negocio?” | Resumen corto de hoy: ventas, gastos y saldo por cobrar; menciona ventas de ayer si hay ventas en alguno de esos días. Sin recomendaciones generativas. |

Periodos admitidos: **hoy, ayer, esta semana, semana pasada, este mes, mes pasado**, una fecha `AAAA-MM-DD` explícita o un rango explícito válido. Las fechas relativas se resuelven en SQL con la zona del negocio; el mes anterior es un mes de calendario y la semana anterior va de lunes a domingo. Las consultas futuras o con rango inválido piden aclaración. Los pagos de deudas no se suman de nuevo a ventas. “Ventas menos gastos registrados”, si se calcula en el futuro, sólo podrá llamarse **diferencia entre ventas y gastos registrados**, nunca utilidad o ganancia neta. No hay resúmenes programados, notificaciones, asesoría generativa ni dashboard complejo.

El contrato de Gemini es `{ambiguous, operations}`. Cada operación conserva `kind`, importe expresado o `quantity` y `unit_price`, fecha relativa y contacto cuando aplican. `sale_ref` enlaza una deuda con la posición de su venta en la lista; `upfront_paid` conserva un pago inicial explícito. Gemini sólo extrae datos: JS valida cada operación y calcula cantidad × precio en centavos; SQL decide saldos, fechas definitivas y mutaciones. La respuesta se compone en código, no en Gemini. Cada movimiento guarda `source_message_id` y tiene su propia fila de `movement_audit`. Un reintento con el mismo ID devuelve el recibo sin repetir el lote.

Ejemplos: “Vendí 3 playeras en $900 y gasté $200 de gasolina”; “Ayer vendí $2,500, hoy llevo $1,800”; “Luis me debe $700 y Pedro $400”; “Vendí dos pantalones de $600 cada uno y una chamarra de $900”. “Le vendí a Pedro $600 y me lo quedó a deber” crea una venta y una deuda por $600. “Le vendí a Juan $1,000, me pagó $400 y me debe $600” crea una venta de $1,000 y una deuda de $600, con $400 de pago inicial anotado en la interpretación; no crea una segunda venta ni descuenta dos veces la deuda. El total de ventas no debe interpretarse como caja. No hay inventarios, SAT, facturas, empleados, recordatorios automáticos ni reportes de utilidad.

## Configurar Supabase nuevo

1. Identifica por nombre e ID el **proyecto Supabase nuevo y exclusivo de Cuenta Clara**. Verifica su cuenta antes de ejecutar SQL. No selecciones uno existente de clientes o producción.
2. En un proyecto vacío ejecuta en orden `001_initial.sql`, `002_batches.sql`, `003_queries.sql` y `004_pilot.sql`. Si ya se completó Sprint 5, ejecuta **sólo** `supabase/migrations/004_pilot.sql`. Verifica la referencia del proyecto antes de ejecutar SQL.
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
| `GEMINI_TRANSCRIBE_MODEL` | Opcional: modelo Gemini para transcribir audio; por defecto usa `GEMINI_MODEL`. No requiere otra clave. |
| `PILOT_SIGNUP_ENABLED` | `true` para mostrar altas con invitación en el deployment piloto; `false` por defecto. |
| `PILOT_INVITE_CODE` | Código secreto largo para los vendedores invitados; sólo en entorno seguro, no en Git ni frontend. |
| `PILOT_MESSAGES_PER_MINUTE` / `PILOT_MESSAGES_PER_DAY` | Límites configurables; valores por defecto 30 y 250. |
| `VOICE_SMOKE_FILE` | Sólo prueba local real: ruta del audio temporal con “Gasté trescientos cincuenta pesos de gasolina”. |
| `VOICE_BATCH_SMOKE_FILE` | Opcional para `test:batch-live`: WAV temporal con dos operaciones claras. No se conserva. |
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
npm run test:batch-gemini
npm run test:queries-gemini
```

Con la migración y las demás variables configuradas en el proyecto Supabase aislado:

```sh
npm run test:live
npm run test:batch-live
npm run test:queries-live
npm run test:pilot-live
```

`test:queries-gemini` comprueba 14 preguntas con Gemini real sin consultar datos. `test:queries-live` crea un negocio de prueba nuevo en el proyecto Supabase confirmado, registra venta/gasto/deuda y verifica total diario, resumen semanal, deudores, comparación con cero, idempotencia y auditoría. Las pruebas de sprints previos siguen disponibles; los negocios de prueba se conservan para inspección. `SUPABASE_PROJECT_REF_CONFIRM` debe coincidir con el host de `SUPABASE_URL`.

`test:pilot-live` comprueba el alta de negocio piloto, eventos, panel e idempotencia con Gemini y Supabase reales. Designa como operador al usuario de prueba confirmado `TEST_USER_ID`, crea un negocio de prueba y lo **desactiva** al finalizar; sus registros quedan conservados para auditoría. Debe ejecutarse sólo en el proyecto aislado confirmado y después de `004_pilot.sql`.

Para publicar:

1. Verifica la URL y el propietario del repositorio exclusivo `cristianmonroywork/whatsapp-crm`. Sube exclusivamente esta carpeta.
2. Verifica que el proyecto Vercel existente `montecarlo1/whatsappcrm` (`prj_RbLP3TpxpJxLNxDLUCXquaZwO9aA`) sigue conectado a ese repositorio. Framework: Other; Node 24; salida: `public`; instalación `npm ci`; no requiere compilación del frontend.
3. Conserva las variables de ese proyecto con `APP_MODE=live`. La función vive en `api/index.js`; `vercel.json` contiene las rutas.
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

## Notas de voz en la web/PWA

El usuario pulsa **Grabar**, **Detener**, escucha la nota y puede **Cancelar** o **Enviar audio**. También puede subir un archivo. El navegador solicita permiso de micrófono; en móviles se requiere HTTPS (o localhost). La interfaz limita la grabación a 59 segundos para dejar margen al límite del servidor. Una nota puede contener varias operaciones claras.

```text
Micrófono / archivo → API autenticada → validación real de audio → Gemini transcriptor
→ transcripción visible → mismo intérprete Gemini de texto → validación financiera
→ misma transacción Supabase → respuesta visible
```

Gemini se usa para transcripción porque acepta audio pequeño en línea y la clave/modelo ya pertenecen al proyecto aislado. La llamada de transcripción tiene un adaptador independiente (`src/voice.js`) que puede sustituirse sin tocar la lógica financiera. El transcriptor no recibe saldos ni acceso a Supabase; sólo devuelve palabras. El intérprete tampoco escribe en la base. Los totales, centavos, fechas y confirmaciones siguen en código/SQL. Se eligió audio en línea para evitar una subida persistente al proveedor.

El servidor acepta WAV, WebM, OGG, MP3 y M4A/MP4. Comprueba MIME, firma del archivo y metadatos de duración; rechaza archivos vacíos, ilegibles, con video, mayores de **3,000,000 bytes** o **60 segundos**. El límite de 3 MB deja margen para la codificación Base64 dentro del máximo de cuerpo de Vercel. Una transcripción vacía o un lote ambiguo no crea movimientos. Las correcciones y anulaciones habladas conservan el código de confirmación actual.

El audio sólo vive en memoria durante la petición y se descarta al terminar; no se guarda en Storage, tablas, logs ni repositorio. En Supabase se conservan `messages.content` (transcripción), `messages.media` (tipo audio, origen web, transcripción, MIME, tamaño, duración, códec, hash SHA-256 y modelo/proveedor), actor, negocio, fecha, respuesta e ID interno. `movements.source_message_id` y `movement_audit.message_id` vinculan el movimiento y las correcciones. Gemini recibe temporalmente el audio conforme a la configuración de datos del proveedor. El navegador mantiene la vista previa local sólo hasta enviar o cancelar; una petición fallida la conserva para reintentar con el mismo identificador.

Para probar sin escribir en Supabase: `npm test` cubre el endpoint con PostgreSQL local y un transcriptor simulado; `npm run check` revisa sintaxis. En modo `live`, inicia sesión en la web, graba “Gasté 350 pesos de gasolina”, escucha y envía. Debe aparecer “Escuché: …” seguido del gasto de $350. Revisa `messages`, `movements` y `movement_audit` en el proyecto Supabase exclusivo de Cuenta Clara. La prueba controlada `npm run test:voice-live` recibe un archivo local mediante `VOICE_SMOKE_FILE` con la frase “Gasté trescientos cincuenta pesos de gasolina”; exige confirmar el proyecto Supabase `vixbjjjeewcjawwemvnx` y el negocio piloto mediante las variables existentes, y registra un gasto real de $350 antes de revisar auditoría e idempotencia. En macOS se puede generar un ejemplo temporal así:

```sh
say -v Paulina -o /private/tmp/cuenta-clara-sprint3.aiff 'Gasté trescientos cincuenta pesos de gasolina'
afconvert -f WAVE -d LEI16@16000 /private/tmp/cuenta-clara-sprint3.aiff /private/tmp/cuenta-clara-sprint3.wav
VOICE_SMOKE_FILE=/private/tmp/cuenta-clara-sprint3.wav npm run test:voice-live
rm /private/tmp/cuenta-clara-sprint3.aiff /private/tmp/cuenta-clara-sprint3.wav
```

El intérprete demo sigue separado y sólo entiende los ejemplos de texto limitados; la transcripción de voz real requiere `GEMINI_API_KEY` incluso en desarrollo.

Limitaciones: no hay edición de la transcripción antes de enviarla, guardado de audio ni procesamiento de voz por WhatsApp. Si el proveedor de transcripción falla, no se escribe un mensaje financiero y puede reintentarse con el mismo ID. Una consulta hablada sí usa el mismo transcriptor e intérprete que el texto; no crea un movimiento.

## Pruebas y límites de verificación

`npm test` ejecuta PostgreSQL local real vía PGlite, no un ledger falso de objetos JS: las cuatro migraciones, reglas, SQL y RLS. Cubre los flujos anteriores y, para Sprint 5.5, alta, membresía, bandera de piloto, eventos, límites, panel, desactivación, aislamiento, estado vacío, sesión caducada y errores seguros. PGlite serializa su conexión, así que no sustituye una prueba de carga multiconexión en Supabase. El bloqueo `FOR UPDATE` por negocio implementa la exclusión en PostgreSQL servidor.

Verificación de Sprint 4: **44/44 pruebas locales**; **8/8 ejemplos válidos y 4/4 ambiguos** con Gemini real; prueba integral en el proyecto Supabase aislado con venta de $2,600, gasto de $450 y deuda de $800, consulta diaria de $2,600, reintento sin duplicados y auditoría de cada movimiento. Una nota WAV sintética con dos operaciones también pasó por transcripción, interpretación y persistencia real. En la web desplegada se registró otro lote de venta y gasto y se consultó el total actualizado. Estas pruebas escribieron sólo en un negocio de prueba dedicado, que se conserva para inspección.

Ver [docs/VALIDACION.md](docs/VALIDACION.md) y [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Un fallo de Gemini nunca cambia silenciosamente al intérprete demo.

## Referencias de implementación

- [Gemini: Structured Outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output): contrato de salida JSON Schema en Generate Content.
- [Gemini: audio](https://ai.google.dev/gemini-api/docs/generate-content/audio): audio en línea para transcripción.
- [Vercel: límites de funciones](https://vercel.com/docs/functions/limitations): tamaño máximo del cuerpo HTTP.
- [Supabase: Database Functions](https://supabase.com/docs/guides/database/functions): funciones Postgres y permisos.
- [Vercel: Node.js avanzado](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration): función Node y desactivación de helpers para cuerpo original.
- [Meta: verificación de webhooks en su SDK](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/): firma y handshake. Se usa HTTP directo; no se depende del SDK archivado.
