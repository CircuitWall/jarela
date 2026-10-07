const mutationQueues = new Map<string, Promise<void>>();

export async function withKeyedMutation<Result>(
  key: string,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  mutationQueues.set(key, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}