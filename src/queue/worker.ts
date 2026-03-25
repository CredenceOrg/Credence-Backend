import { validatePayload } from '../middleware/queueValidator.js';
import { queueService } from '../services/queueService.js';

/**
 * Mock function representing a message being picked up from a queue 
 * (Redis, RabbitMQ, or a simple database polling loop).
 */
export async function processIncomingJob(job: { id: string, type: string, data: any }) {
  console.log(`[Worker] Received job ${job.id} of type ${job.type}`);

  // STEP 1: Validate the payload using the schema we built
  const validation = validatePayload(job.type, job.data);

  if (!validation.success) {
    // STEP 2: Route to DLQ (Issue #170 Requirement)
    await queueService.moveToDLQ(
      job.id,
      job.type,
      job.data,
      validation.error || 'Validation failed'
    );
    return;
  }

  // STEP 3: Logic for valid messages
  console.log(` Job ${job.id} is valid. Proceeding with task...`);
  // executeTask(validation.data);
}