export const version = "0.2.2";
export const sourceId = "A";
export const implementationName = "runSourceA";
function runSourceA() { return `A 専用関数: 6 × 7 = ${6 * 7}`; }
export function runSource(element) {
  element.dataset.source = sourceId;
  element.querySelector("h2").textContent = "Hello from Source A! v" + version;
  const proof = runSourceA();
  element.querySelector("p").textContent = proof;
  return proof;
}
