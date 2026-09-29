// Read-only verification of the live Gemini interpretation contract. No database access.
import assert from 'node:assert/strict';
import {interpret} from '../src/interpret.js';
import {normalizeInput} from '../src/domain.js';

const cases=[
 ['Vendí 3 playeras en $900 y gasté $200 de gasolina.',['sale:90000','expense:20000']],
 ['Hoy saqué $4,000 de venta y Juan me quedó a deber $800.',['sale:400000','receivable:80000']],
 ['Pedro me pagó $300 y gasté $150 en comida.',['payment:30000','expense:15000']],
 ['Ayer vendí $2,500, hoy llevo $1,800.',['sale:250000','sale:180000']],
 ['Luis me debe $700 y Pedro $400.',['receivable:70000','receivable:40000']],
 ['Vendí dos pantalones de $600 cada uno y una chamarra de $900.',['sale:120000','sale:90000']],
 ['Le vendí a Pedro $600 y me lo quedó a deber.',['sale:60000','receivable:60000']],
 ['Le vendí a Juan $1,000, me pagó $400 y me debe $600.',['sale:100000','receivable:60000']]
];
const validCases=process.argv.includes('--ambiguous-only')?[]:cases;
for(const [text,expected] of validCases) {
 const command=normalizeInput(await interpret(text));
 const actual=command.operations?.map(op=>`${op.intent}:${op.amount_cents}`);
 assert.deepEqual(actual,expected,`Gemini did not parse: ${text}; received ${JSON.stringify(command)}`);
 console.log(`OK: ${text}`);
}
const ambiguous=['Creo que vendí como 2 o 3 mil.','Juan me pagó algo.','Gasté más o menos $500.','Pedro me debe lo mismo de la vez pasada.'];
for(const text of ambiguous) {
 const command=normalizeInput(await interpret(text));
 assert.equal(command.intent,'clarify',`Ambiguous phrase was accepted: ${text}`);
 console.log(`Clarification: ${text}`);
}
console.log(`Gemini batch interpretation: ${validCases.length} valid and ${ambiguous.length} ambiguous examples passed; no database writes.`);
