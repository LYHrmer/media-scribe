// Actual OCR readings feed production fusion. Synthetic labels are scorer-only.
import fs from 'node:fs/promises';
import { fuseVideoCaptions } from '../../src/video-captions.js';
const [reportPath, expectedPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: OCR_REPORT EXPECTED_JSON OUTPUT');
const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
const expected=JSON.parse(await fs.readFile(expectedPath,'utf8'));
const lexical=s=>s.normalize('NFKC').replace(/[\p{P}\s]/gu,'').toLowerCase();
const rows=[];
for(const [scene, gold] of Object.entries(expected.expected)) {
 const frames=report.results.filter(x=>x.name.startsWith(scene+'-')).map((x,i)=>({time:1+i*.5,width:1000,height:600,texts:x.result.texts}));
 const fused=fuseVideoCaptions(frames,{duration:10});
 const credits=fused.candidates.filter(x=>x.category==='credits');
 const row={scene,frame_count:frames.length,retained_caption:fused.segments.map(x=>x.text),credits:credits.map(x=>x.text),expected_credit_count:gold.credits.length};
 row.pass=frames.length===3 && fused.segments.length===1 && lexical(fused.segments[0].text)===lexical(gold.caption)
  && credits.length===gold.credits.length && gold.credits.every(t=>credits.some(c=>lexical(c.text)===lexical(t)));
 rows.push(row);
}
await fs.writeFile(outputPath,JSON.stringify({scope:expected.scope,font_sha256:expected.font_sha256,worker:report.worker,wasm:report.wasm,rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({scene,pass})=>({scene,pass}))));
if(rows.some(row=>!row.pass))process.exitCode=1;
