/**
 * utils/clientOptions.js — the Client options, and the one that is a safety
 * property rather than a preference.
 *
 * `allowedMentions` exists because this bot relays strings it did not write:
 * task titles typed by users, event titles scraped off a booking site, error
 * text quoted back from an upstream API. Discord's own default parses every
 * mention it finds, so without a default here any of those could ping a whole
 * guild — and a code fence does not suppress it.
 *
 * These are cheap and they fail loudly if someone deletes the line.
 */

const { GatewayIntentBits, Partials } = require('discord.js');
const { clientOptions } = require('../utils/clientOptions');

describe('clientOptions', () => {
    describe('allowedMentions', () => {
        it('parses nothing by default', () => {
            expect(clientOptions.allowedMentions).toEqual({ parse: [] });
        });

        it('allows no mention type through — not everyone, roles, or users', () => {
            const { parse } = clientOptions.allowedMentions;
            expect(parse).not.toContain('everyone');
            expect(parse).not.toContain('roles');
            expect(parse).not.toContain('users');
        });
    });

    describe('intents', () => {
        it.each([
            ['Guilds', GatewayIntentBits.Guilds],
            ['GuildMessages', GatewayIntentBits.GuildMessages],
            ['MessageContent', GatewayIntentBits.MessageContent],
            ['GuildMessageReactions', GatewayIntentBits.GuildMessageReactions],
            ['GuildScheduledEvents', GatewayIntentBits.GuildScheduledEvents],
        ])('declares %s', (_name, bit) => {
            expect(clientOptions.intents).toContain(bit);
        });
    });

    describe('partials', () => {
        // Not tuning: without these, discord.js dereferences undefined inside
        // its own reaction handler and takes the process down. See the comment
        // in the module for the crash this came from.
        it.each([
            ['Message', Partials.Message],
            ['Channel', Partials.Channel],
            ['Reaction', Partials.Reaction],
        ])('declares the %s partial the reaction intent requires', (_name, partial) => {
            expect(clientOptions.partials).toContain(partial);
        });
    });
});
