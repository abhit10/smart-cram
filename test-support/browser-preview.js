// Isolated browser test fixture. Never used by npm start or production routes.
import { createApp } from '../server.js';
import { jsPDF } from 'jspdf';
const app = createApp({ databasePath: ':memory:', origin: 'http://127.0.0.1:3001',
  geminiKey: 'browser-fixture', youtubeKey: 'browser-fixture', fetchImpl: async (url, options) => {
    if (url.includes('youtube')) return { ok: true, json: async () => ({ items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: 'Test video (mock response)', description: 'Browser fixture only; not a live search result.', channelTitle: 'Test fixture', publishedAt: '2026-01-01' } }] }) };
    const body = JSON.parse(options.body);
    const text = body.generationConfig ? JSON.stringify([{ question: 'When did the French Revolution begin?', answer: '1789' }, { question: 'What was stormed?', answer: 'The Bastille' }]) : 'Mock study response: the French Revolution began in 1789.';
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
  }
});
app.listen(3001, '127.0.0.1', async () => {
  const response = await fetch('http://127.0.0.1:3001/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Browser Test', email: 'test@example.com', password: 'Browser-test-only-123' }) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const pdf = new jsPDF();
  pdf.text('Browser test textbook', 20, 20);
  pdf.text('The French Revolution began in 1789. The Bastille was stormed.', 20, 35);
  pdf.addPage(); pdf.text('Nationalism in Europe: a second textbook page.', 20, 20);
  await fetch('http://127.0.0.1:3001/api/textbook', { method: 'PUT', headers: { 'Content-Type': 'application/pdf', Cookie: cookie }, body: Buffer.from(pdf.output('arraybuffer')) });
  console.log('MOCK browser fixture: http://127.0.0.1:3001 — test@example.com / Browser-test-only-123');
});
