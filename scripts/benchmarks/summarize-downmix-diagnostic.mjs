// Redact reference/transcript bodies; publish only hashes and measurements.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scoreTranscript} from './score-transcripts.mjs';
const [normalPath,forcedPath,planPath,outputPath]=process.argv.slice(2);
if(!outputPath)throw Error('Usage: NORMAL_PRIVATE_REPORT FORCED_PRIVATE_REPORT PLAN OUTPUT');
const sha=s=>createHash('sha256').update(s).digest('hex');
const raw=await fs.readFile(normalPath),forcedRaw=await fs.readFile(forcedPath),planRaw=await fs.readFile(planPath);
const normal=JSON.parse(raw),forced=JSON.parse(forcedRaw),plan=JSON.parse(planRaw);
const main=rows=>rows.filter(c=>!c.id.startsWith('short')).map(c=>({id:c.id,pcm_sha256:c.pcm_sha256,score:c.score,seconds:c.seconds,asr_deferred:!!c.result.speechCheck.skipAsr}));
const aggregate=report=>{
 const slices=report.cases.filter(c=>c.id.startsWith('short')).sort((a,b)=>a.id.localeCompare(b.id));
 if(slices.length!==plan.offsets.length-1)throw Error('Incomplete segment run');
 const control=report.cases.find(c=>c.id==='browser-mix');
 return {score:scoreTranscript(control.reference,slices.map(c=>c.result.text).join(''),'chinese'),
   sample_count:plan.offsets.at(-1),segments:slices.map((c,i)=>({id:c.id,pcm_sha256:c.pcm_sha256,start_sample:plan.offsets[i],end_sample:plan.offsets[i+1],asr_deferred:!!c.result.speechCheck.skipAsr,seconds:c.seconds}))};
};
const report={scope:'Development diagnostic: one previously seen private lyric video, one vendor Chinese speech recording, derived pause control, two synthetic negative controls. Not a holdout or browser/media-decoder test.',
 method:'First reproduce previous ffmpeg mono and browser-style average. One fixed <=8s non-overlap variant. Initial runner applies VAD per slice; adaptive follow-up disables that gate for all slices and the whole-input control, matching a once-gated full recording. Reference only reaches the scorer.',
 adopted:false,reason:'Short chunks still have 15 errors over 22 reference characters; no general accuracy evidence.',
 inputs:{normal_report_sha256:sha(raw),forced_report_sha256:sha(forcedRaw),frozen_plan_sha256:sha(planRaw)},plan,
 fingerprints:normal.fingerprints,model_sha256:normal.model_sha256,runtime_sha256:normal.runtime_sha256,
 ordinary:main(normal.cases),slice_vad:aggregate(normal),forced_control:main(forced.cases),forced_slices:aggregate(forced)};
await fs.writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({errors:report.forced_slices.score.character_errors,reference_count:report.forced_slices.score.reference_character_count,adopted:false}));
