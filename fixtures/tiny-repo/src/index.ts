import { registerUser, validateUser } from './auth.service';
import { slugify } from './utils';

async function main() {
  const user = registerUser('demo@example.com', 'hunter2');
  console.log('Registered', slugify(user.email));

  const result = await validateUser('demo@example.com', 'hunter2');
  console.log('Validated:', result !== null);
}

main();
