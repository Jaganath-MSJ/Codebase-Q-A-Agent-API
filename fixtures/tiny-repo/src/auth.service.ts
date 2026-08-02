export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

const users: User[] = [];

export function findUserByEmail(email: string): User | undefined {
  return users.find((user) => user.email === email);
}

export async function validateUser(email: string, password: string): Promise<User | null> {
  const user = findUserByEmail(email);
  if (!user) return null;

  const ok = await comparePassword(password, user.passwordHash);
  return ok ? user : null;
}

async function comparePassword(password: string, hash: string): Promise<boolean> {
  // Placeholder fixture logic — not real authentication.
  return `hashed:${password}` === hash;
}

export function registerUser(email: string, password: string): User {
  const user: User = {
    id: String(users.length + 1),
    email,
    passwordHash: `hashed:${password}`,
  };
  users.push(user);
  return user;
}
