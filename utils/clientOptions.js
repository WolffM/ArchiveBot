/**
 * The discord.js Client options, in their own module so the guarantees they
 * encode can be asserted. index.js logs in on require, so anything declared
 * inline there is untestable by construction — and `allowedMentions` is a
 * safety property, not a preference.
 */

const { GatewayIntentBits, Partials } = require('discord.js');

const clientOptions = {
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildScheduledEvents
    ],
    // REQUIRED by the GuildMessageReactions intent above — not optional tuning.
    //
    // The intent makes the gateway send MESSAGE_REACTION_ADD/REMOVE, and
    // discord.js processes those packets internally whether or not we listen.
    // Its Action.getPayload does:
    //
    //   partials.includes(type) ? manager._add(data, cache) : manager.cache.get(id)
    //
    // With no partials declared and the message NOT in cache, `manager` is
    // undefined and it throws inside the event handler — an unhandled rejection
    // that KILLS the process. That is exactly what happened 2026-07-28 20:09:55Z:
    //
    //   TypeError: Cannot read properties of undefined (reading 'get')
    //     at MessageReactionRemove.getPayload (discord.js/src/client/actions/Action.js:29)
    //
    // This bot archives channels years deep, so "someone un-reacts to a message
    // we never cached" is routine, not exotic. Declaring the partials lets
    // discord.js hand itself a partial object instead of dereferencing undefined.
    //
    // NOTE: we register no reaction listeners at all — reaction DATA is read over
    // REST in lib/archive.js (channel.messages.fetch → message.reactions.cache),
    // which intents do not gate. So the intent itself may well be droppable,
    // which would stop the traffic at the source. Left in place deliberately:
    // removing it risks silently losing reaction archiving if that reading is
    // wrong, and silent data loss is a worse trade than some unused gateway
    // events. Verify against a real archive run before pruning it.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    // Nothing may ping a guild by accident. Discord's own default parses every
    // mention it finds in content, so a string this bot merely PASSES THROUGH
    // decides who gets notified: a task titled "@everyone", a scraped event
    // title, an upstream error message quoted back into a channel.
    //
    // Two paths already defended themselves (lib/messageWebhook.js and the
    // scheduler), four did not — archive status lines, the task list, the
    // pickleball outcomes and the waitlist webhook all sent bare strings, and a
    // code fence does NOT suppress a mention. Defaulting here is what makes the
    // safe case automatic rather than something each new send site has to
    // remember.
    //
    // A per-message allowedMentions REPLACES this, so the deliberate mentions
    // still work: the scheduler passes { users: [...] } for event reminders and
    // { parse: ['everyone'] } where an item explicitly asked for it.
    allowedMentions: { parse: [] }
};

module.exports = { clientOptions };
