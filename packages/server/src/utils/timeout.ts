export function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (value) => {
        clearTimeout(t);
        resolve(value);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
