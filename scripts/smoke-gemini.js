import assert from 'node:assert/strict';
import {interpret} from '../src/interpret.js';
import {normalize} from '../src/domain.js';

if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
const sale=normalize(await interpret('Vendí 3 playeras en $900'));
assert.equal(sale.intent,'sale');
assert.equal(sale.amount_cents,90000);
const query=normalize(await interpret('¿Cuánto vendí hoy?'));
assert.equal(query.intent,'totals');
assert.equal(query.period,'day');
console.log('Gemini real interpretó venta $900 y consulta diaria. Ningún dato financiero fue escrito.');
