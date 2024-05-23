import { Method } from '@proteinjs/reflection';

export function isVoidReturnType(method: Method) {
  return !method.returnType || method.returnType.name === 'void' || method.returnType.name === 'Promise<void>';
}
