// Prints slug() for a few sample inputs, so a person or an agent can see what the product does.
import { slug } from './slug.mjs';

for (const input of ['Hello World', '  Trim Me  ', 'Rock & Roll!']) {
  try {
    console.log(`${JSON.stringify(input)} -> ${JSON.stringify(slug(input))}`);
  } catch (error) {
    console.log(`${JSON.stringify(input)} -> error: ${error.message}`);
  }
}
