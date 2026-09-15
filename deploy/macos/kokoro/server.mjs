import http from 'node:http';
import path from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
const root=process.env.ELARA_ROOT || path.resolve(import.meta.dirname,'../..');
env.cacheDir=path.join(root,'models','kokoro-cache');
env.allowRemoteModels=false;
// All model files and voices were installed beforehand. Never fetch at runtime.
globalThis.fetch=async()=>{throw new Error('Network downloads are disabled in the local speech service');};
const tts=await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',{dtype:'fp32',device:'cpu'});
await tts.generate('Ready.',{voice:'af_heart'});
let busy=false;
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET' && req.url==='/health'){
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',engine:'kokoro',precision:'fp32',local:true,busy}));return;
 }
 if(req.method!=='POST' || req.url!=='/v1/audio/speech'){res.writeHead(404);res.end();return;}
 if(busy){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Speech synthesis is finishing'}));return;}
 let acquired=false;
 let cancelled=false;res.on('close',()=>{cancelled=true;});
 try{
  const chunks=[];let bytes=0;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>12000)throw new Error('Speech request is too large');chunks.push(chunk);}
  const body=JSON.parse(Buffer.concat(chunks));
  if(typeof body.input!=='string'||!body.input.trim()||body.input.length>600)throw new Error('Speech text must contain 1–600 characters');
  const voice=body.voice||'af_heart';const speed=body.speed??1;
  if(!Object.hasOwn(tts.voices,voice))throw new Error('Unknown local voice');
  if(typeof speed!=='number'||!Number.isFinite(speed)||speed<0.85||speed>1.15)throw new Error('Speech speed must be 0.85–1.15');
  if(cancelled)return;
  if(busy){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Speech synthesis is finishing'}));return;}
  busy=true;acquired=true;
  const audio=await tts.generate(body.input,{voice,speed});
  if(cancelled)return;
  const samples=audio.audio;let peak=0;
  for(const sample of samples){if(!Number.isFinite(sample))throw new Error('Invalid generated audio');peak=Math.max(peak,Math.abs(sample));}
  const gain=peak>0.98?0.98/peak:1;const pcm=Buffer.alloc(samples.length*2);
  for(let i=0;i<samples.length;i++)pcm.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]*gain))*32767),i*2);
  res.writeHead(200,{'Content-Type':'audio/pcm','X-Sample-Rate':'24000','X-Sample-Format':'s16le','Content-Length':String(pcm.length),'Cache-Control':'no-store'});res.end(pcm);
 }catch(error){if(!res.destroyed){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}}
 finally{if(acquired)busy=false;}
});
server.listen(7863,'127.0.0.1',()=>console.log('Kokoro fp32 is ready on localhost:7863; all inference is local.'));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>process.exit(0)));
