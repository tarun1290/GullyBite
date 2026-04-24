import { GULLYBITE_WA_NUMBER_DIGITS } from '../config/contact';

export function waLink(msg: string = 'Hi, I want to learn about GullyBite for my restaurant'): string {
  const text = encodeURIComponent(msg);
  return `https://wa.me/${GULLYBITE_WA_NUMBER_DIGITS}?text=${text}`;
}
