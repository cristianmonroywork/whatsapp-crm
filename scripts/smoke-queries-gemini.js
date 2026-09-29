// Read-only interpretation check; no Supabase access or financial figures from Gemini.
import assert from 'node:assert/strict';
import {interpret} from '../src/interpret.js';
import {normalizeInput} from '../src/domain.js';
const cases=[
 ['¿Cuánto vendí hoy?','totals','day','sales'],
 ['¿Cuánto vendí ayer?','totals','day','sales'],
 ['¿Cuánto vendí esta semana?','totals','week','sales'],
 ['¿Cuánto gasté esta semana?','totals','week','expenses'],
 ['¿Cuánto me deben?','balance','day','all'],
 ['¿Quién me debe?','debtors','day','all'],
 ['¿Cómo me fue esta semana?','summary','week','all'],
 ['¿Vendí más que la semana pasada?','comparison','week','all'],
 ['¿Cuál fue mi mejor día?','best_day','all','all'],
 ['¿Cómo va mi negocio?','business_overview','day','all'],
 ['¿Cuánto vendí la semana pasada?','totals','last_week','sales'],
 ['¿Cuánto gasté el mes pasado?','totals','last_month','expenses']
];
for(const [text,intent,period,metric] of cases) {
 const parsed=normalizeInput(await interpret(text));
 assert.deepEqual([parsed.intent,parsed.period,parsed.metric],[intent,period,metric],`${text}: ${JSON.stringify(parsed)}`);
 console.log(`OK ${text}`);
}
const dated=normalizeInput(await interpret('¿Cuánto vendí el 2025-04-17?'));
assert.deepEqual([dated.intent,dated.date,dated.period,dated.metric],['totals','2025-04-17','day','sales']);
const range=normalizeInput(await interpret('¿Cuánto vendí del 2025-04-01 al 2025-04-05?'));
assert.deepEqual([range.intent,range.period,range.from_date,range.to_date,range.metric],['totals','range','2025-04-01','2025-04-05','sales']);
console.log(`${cases.length+2} real Gemini query interpretations passed; no database writes.`);
