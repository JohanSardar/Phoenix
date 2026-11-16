import { readFileSync } from "node:fs";

const file = process.env.PHOENIX_CLOCK_FILE ?? "/phoenix-clock";
const offset = Number(/^([+-]?\d+(?:\.\d+)?)s/.exec(readFileSync(file, "utf8").trim())?.[1] ?? Number.NaN) * 1000;
if (!Number.isFinite(offset)) throw new Error(`The box clock file ${file} holds no offset`);
const Real = Date;
function MomentDate(...args) {
  if (!new.target) return new Real(Real.now() + offset).toString();
  return Reflect.construct(Real, args.length ? args : [Real.now() + offset], new.target);
}
Object.setPrototypeOf(MomentDate, Real);
MomentDate.prototype = Real.prototype;
MomentDate.now = () => Real.now() + offset;
globalThis.Date = MomentDate;
