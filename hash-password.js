// Uso: node hash-password.js "la contraseña"
// Imprime el hash para pegar en stores.json (campo adminPasswordHash).
const crypto = require('crypto');
const pwd = process.argv[2];
if (!pwd || pwd.length < 10) {
  console.error('Pasá una contraseña de al menos 10 caracteres: node hash-password.js "mi contraseña larga"');
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(pwd, salt, 64).toString('hex');
console.log(`scrypt$${salt}$${hash}`);
