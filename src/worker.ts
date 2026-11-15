import { parentPort, workerData } from 'node:worker_threads';
import { readBook, extractImage, type WorkerRequest } from './formats';
const request = workerData as WorkerRequest;
const task = request.action === 'image' ? extractImage(request.bytes, request, request.imageId ?? '') : readBook(request.bytes, request);
void task.then(result => parentPort!.postMessage({ result }), error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }));
