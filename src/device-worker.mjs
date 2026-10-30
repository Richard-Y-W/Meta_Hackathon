import { randomInt, createHash, randomBytes } from 'node:crypto';
import { hypotheses, INITIAL, transition } from './domain.mjs';

// Private process. No selected rule, seed, or rule ID is returned to the learner.
const family = hypotheses();
let model = family[randomInt(family.length)], state = { ...INITIAL };
let salt = randomBytes(32).toString('hex');
const commitment = () => createHash('sha256').update(`${salt}:${model.id}`).digest('hex');
process.on('message', ({ id, command, action }) => {
  if (command === 'press') state = transition(model, state, action);
  if (command === 'mutate') {
    const alternatives = family.filter(m => m.id !== model.id);
    model = alternatives[randomInt(alternatives.length)];
    salt = randomBytes(32).toString('hex');
  }
  process.send({ id, observation: { ...state }, commitment: commitment() });
});
