# Validación de entrega — Sprint 1

Sprint 1 original: 23 de septiembre de 2026. Sprint 1.5 (Gemini): 27 de septiembre de 2026, America/Mexico_City.

## Resultado comprobado

- `npm test` después de sustituir OpenAI por Gemini: **25 pruebas, 25 aprobadas, 0 fallidas, 0 omitidas**.
- `npm run check`: sintaxis JavaScript, configuración de cuerpo HTTP original en Vercel y ausencia de claves de servidor en archivos públicos: **correctos**.
- Prueba visual en el chat local: `Vendí 3 playeras en $900` → `Venta registrada: $900.00 MXN.` → `¿Cuánto vendí hoy?` → `Ventas: $900.00 MXN.`
- La demo local quedó con esa venta de muestra y las dos entradas de mensaje. Repetir la venta con un mensaje nuevo aumenta el total; no representa un fallo de idempotencia.

## Cobertura de las 25 pruebas

1. Flujo Sprint 1 desde texto español hasta consulta de $900 en PostgreSQL.
2. Gastos, totales y multiplicación exacta de precio unitario en centavos.
3. Corrección sólo tras confirmar; auditoría antes/después.
4. Anulación lógica con confirmación; rechazo de reutilización de código.
5. Deuda, pago parcial y pago final; sin sumar cobros como ventas.
6. Pago sin deuda, sobrepago y ambigüedad por múltiples deudas.
7. Duplicados, peticiones concurrentes y conflicto de contenido con mismo ID.
8. Dos pagos concurrentes no pueden sobrepagar.
9. Separación entre negocios y autorización también dentro de SQL.
10. RLS; lectura ajena, escritura directa y RPC privilegiada denegadas.
11. Zona horaria del negocio, ayer y mes; rechazo de zona inválida.
12. Código vencido, cancelado y sustituido por nueva solicitud.
13. Objetivo de corrección fijo aunque aparezca una venta posterior.
14. Código vinculado al usuario y canal; versión obsoleta rechazada.
15. Restricciones sobre cuentas con pagos; corrección/anulación de abonos.
16. Estructura de IA inválida o ambigua sin modificación financiera.
17. Fallo de interpretación sin recibo parcial; reintento seguro.
18. Contrato Gemini con JSON Schema, bloqueo de seguridad, truncación y JSON malformado.
19. Adaptador Supabase: ruta RPC, parámetros y secreto de servidor.
20. Firma WhatsApp, lote, duplicados, audio pendiente y reintento de envío.
21. API HTTP de chat, autenticación, origen y tamaño del cuerpo.
22. Cuota persistente; reintento de recibo conocido sin gastar IA.
23. Respuestas exitosas vacías de Supabase tras una escritura.
24. Fecha futura sin movimiento; solicita aclaración.
25. Handshake/firma HMAC sobre bytes originales y rechazo de demo bajo Vercel.

## Qué se ejecutó y qué no

El motor SQL fue PostgreSQL local vía PGlite usando la migración entregada. Los roles y `auth.uid()` tienen sustitutos locales para probar políticas; no se arrancó todo Supabase. PGlite serializa una conexión; las pruebas concurrentes verifican el resultado y la deduplicación, pero no certifican carga ni bloqueos entre conexiones remotas.

Las respuestas HTTP de Gemini, Meta y el adaptador REST de Supabase se simularon. La prueba visual original usó el intérprete demo; la adaptación Gemini aún requiere prueba real con la clave exclusiva. La sintaxis/configuración de Vercel se revisó, pero el despliegue en la cuenta nueva requiere verificar su identidad antes de crear el proyecto.

## Pendiente para aceptar Sprint 1 en la nube

1. Verificar los ID y propietarios de GitHub, Supabase, Gemini y Vercel exclusivos de Cuenta Clara.
2. Ejecutar migración sólo en el proyecto Supabase nuevo identificado.
3. Crear usuario de prueba, configurar claves locales y ejecutar `npm run test:gemini` y `npm run test:live`.
4. Confirmar $900 y los tres registros en Supabase real; conservar el ID de negocio emitido por la prueba.
5. Subir sólo este proyecto al GitHub nuevo, desplegar en la cuenta Vercel nueva y probar sesión y chat.
6. WhatsApp queda desconectado hasta completar este sprint.

El script real comprueba explícitamente el identificador de proyecto y crea su propio negocio de prueba. No modifica un libro existente. No se declara finalizado el hito remoto hasta superar esos pasos.
