/**
 * Contract tests: the discord.js mocks must name things the way discord.js
 * names them.
 *
 * These exist because of a bug that cost a real reminder. `scheduledStartTime`
 * is the name of the create/edit OPTION; a fetched GuildScheduledEvent exposes
 * the value as `scheduledStartAt`. The mock defined the option's name as a
 * property, so `event.scheduledStartTime` — undefined against the real library
 * — read fine in every test. Two separate features shipped dead because of it:
 * the gateway start-time sync in handleScheduledEventUpdate, and the tick's
 * reconcileWithScheduledEvent.
 *
 * A mock that agrees with the code instead of with the library cannot catch
 * that class of mistake, so these assert against the real prototype. They are
 * cheap, and they fail the day a discord.js upgrade renames something.
 */

const { GuildScheduledEvent } = require('discord.js');
const { createMockScheduledEvent, createMockGuild } = require('./mocks/discord');

/**
 * The time fields, which are accessors on the prototype and so are
 * introspectable without an instance. The other things the scheduler reads —
 * name, status, entityMetadata — are assigned in the constructor and invisible
 * here, so they are left to the behavioural tests rather than asserted with
 * something that cannot fail.
 */
const TIME_ACCESSORS = ['scheduledStartAt', 'scheduledEndAt'];

/** Names that exist only as create/edit options — never as readable properties. */
const OPTION_ONLY = ['scheduledStartTime', 'scheduledEndTime'];

describe('discord.js mock fidelity', () => {
    describe('GuildScheduledEvent', () => {
        it.each(TIME_ACCESSORS)(
            '%s is a real accessor on the library class',
            (prop) => {
                expect(
                    Object.getOwnPropertyDescriptor(GuildScheduledEvent.prototype, prop)
                ).toBeDefined();
            }
        );

        it.each(OPTION_ONLY)('%s is NOT a readable property on the library class', (prop) => {
            expect(
                Object.getOwnPropertyDescriptor(GuildScheduledEvent.prototype, prop)
            ).toBeUndefined();
        });

        it.each(TIME_ACCESSORS)('the mock exposes %s too', (prop) => {
            expect(createMockScheduledEvent()).toHaveProperty(prop);
        });

        it.each(OPTION_ONLY)('the mock does not invent %s as a property', (prop) => {
            expect(createMockScheduledEvent()[prop]).toBeUndefined();
        });
    });

    describe('the mock translates option names to property names', () => {
        it('create takes scheduledStartTime and yields scheduledStartAt', async () => {
            const guild = createMockGuild();
            const start = new Date(Date.now() + 7200000);
            const event = await guild.scheduledEvents.create({
                name: 'Contract',
                scheduledStartTime: start,
                scheduledEndTime: null,
            });

            expect(event.scheduledStartAt).toEqual(start);
            expect(event.scheduledStartTime).toBeUndefined();
        });

        it('edit takes scheduledStartTime and moves scheduledStartAt', async () => {
            const event = createMockScheduledEvent();
            const moved = new Date(Date.now() + 86400000);

            await event.edit({ name: 'Moved', scheduledStartTime: moved });

            expect(event.name).toBe('Moved');
            expect(event.scheduledStartAt).toEqual(moved);
            expect(event.scheduledStartTime).toBeUndefined();
        });
    });

    describe('scheduledEvents.fetch', () => {
        it('resolves the options form the scheduler uses for a forced read', async () => {
            const guild = createMockGuild();
            const created = await guild.scheduledEvents.create({
                name: 'Fetchable',
                scheduledStartTime: new Date(Date.now() + 3600000),
            });

            await expect(
                guild.scheduledEvents.fetch({ guildScheduledEvent: created.id, force: true })
            ).resolves.toBe(created);
            await expect(guild.scheduledEvents.fetch(created.id)).resolves.toBe(created);
        });

        it('answers an unknown id with 10070, the code the scheduler retires items on', async () => {
            const guild = createMockGuild();
            await expect(
                guild.scheduledEvents.fetch({ guildScheduledEvent: 'nope', force: true })
            ).rejects.toMatchObject({ code: 10070 });
        });
    });
});
