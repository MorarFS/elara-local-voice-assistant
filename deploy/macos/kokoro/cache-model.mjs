import path from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const destination = process.argv[2];
if (!destination) throw new Error('Pass the Kokoro cache directory');
env.cacheDir = path.resolve(destination);
env.allowRemoteModels = true;
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
await tts.generate('Elara is ready.', { voice: 'af_heart' });
console.log(`Kokoro cached in ${env.cacheDir}`);
