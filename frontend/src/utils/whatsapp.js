import { GULLYBITE_WA_NUMBER_DIGITS } from '../config/contact.js';

export function waLink(msg = 'Hi, I want to learn about GullyBite for my restaurant') {
  const text = encodeURIComponent(msg);
  return `https://wa.me/${GULLYBITE_WA_NUMBER_DIGITS}?text=${text}`;
}
