// The table was created with table.enum('frequency', ['DAY','WEEK','MONTH']),
// which on Postgres is a text column plus a check constraint. YEAR and ALL were
// added to the Frequency enum later, so the service accepted them and the insert
// then failed on the constraint.
const ALLOWED = ['DAY', 'WEEK', 'MONTH', 'YEAR', 'ALL'];
const ORIGINAL = ['DAY', 'WEEK', 'MONTH'];

const list = (values) => values.map((v) => `'${v}'::text`).join(', ');

exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE subscriptions
      DROP CONSTRAINT IF EXISTS subscriptions_frequency_check
  `);
  await knex.raw(`
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_frequency_check
      CHECK (frequency = ANY (ARRAY[${list(ALLOWED)}]))
  `);
};

// Fails loudly if any subscription already uses YEAR or ALL. Rewriting those
// rows to fit the narrower constraint would silently change what a user
// subscribed to, so that is left as a deliberate decision rather than a
// side effect of rolling back.
exports.down = async (knex) => {
  await knex.raw(`
    ALTER TABLE subscriptions
      DROP CONSTRAINT IF EXISTS subscriptions_frequency_check
  `);
  await knex.raw(`
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_frequency_check
      CHECK (frequency = ANY (ARRAY[${list(ORIGINAL)}]))
  `);
};
