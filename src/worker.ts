import { parentPort, workerData } from 'node:worker_threads';
import { readEpub } from './epub';
void readEpub(workerData as Uint8Array).then(book => parentPort!.postMessage({ book }), error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }));
