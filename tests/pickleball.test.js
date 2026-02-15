const axios = require('axios');

// Mock axios before requiring the module
jest.mock('axios', () => {
    const mockInstance = {
        post: jest.fn(),
        get: jest.fn()
    };
    return {
        create: jest.fn(() => mockInstance),
        _instance: mockInstance
    };
});

// Mock discord.js components
jest.mock('discord.js', () => ({
    ActionRowBuilder: class {
        constructor() { this.components = []; }
        addComponents(...args) { this.components.push(...args); return this; }
    },
    ButtonBuilder: class {
        constructor() { this._data = {}; }
        setLabel(l) { this._data.label = l; return this; }
        setStyle(s) { this._data.style = s; return this; }
        setURL(u) { this._data.url = u; return this; }
    },
    ButtonStyle: { Link: 5 }
}));

// Set env vars before requiring module
process.env.SCRAPE_API_URL = 'http://localhost:8000';
process.env.SCRAPE_API_KEY = 'test-key';

const pickleball = require('../lib/pickleball');
const api = axios._instance;

function createMockChannel() {
    const sent = [];
    return {
        send: jest.fn(msg => {
            const sentMsg = {
                ...msg,
                edit: jest.fn().mockResolvedValue(undefined)
            };
            sent.push(sentMsg);
            return Promise.resolve(sentMsg);
        }),
        _sent: sent
    };
}

describe('pickleball', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('executeAction', () => {
        it('should call runSignupAction for pickleball_signup', async () => {
            api.post.mockResolvedValueOnce({
                data: { success: true, data: { message: 'Signup started', status: 'running' } }
            });
            api.get.mockResolvedValueOnce({
                data: { success: true, data: { status: 'completed', event_title: 'Test Event', matched_time: '7pm-9pm', spots_left: 4, event_url: 'https://example.com' } }
            });

            const channel = createMockChannel();
            await pickleball.executeAction('pickleball_signup', channel);

            expect(api.post).toHaveBeenCalledWith('/api/v1/pickleball/signup', expect.objectContaining({
                event_day: 'Tue',
                event_time: '7pm-9pm',
                event_name: 'Open Play - Social / Low Intermediate',
                location: 'Lynnwood'
            }));
        });

        it('should call runFindAction for pickleball_find', async () => {
            api.post.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        event_title: 'Open Play - Intermediate',
                        matched_time: '7:00pm - 9:00pm',
                        spots_left: 6,
                        signup_url: 'https://pickleballkingdom.podplay.app/community/events/abc123/signup'
                    }
                }
            });

            const channel = createMockChannel();
            await pickleball.executeAction('pickleball_find', channel);

            expect(api.post).toHaveBeenCalledWith('/api/v1/pickleball/find', expect.objectContaining({
                event_day: 'Wed',
                event_time: '7pm-9pm',
                event_name: 'Open Play - Intermediate',
                location: 'Lynnwood'
            }));
        });

        it('should do nothing for unknown actions', async () => {
            const channel = createMockChannel();
            await pickleball.executeAction('unknown_action', channel);

            expect(api.post).not.toHaveBeenCalled();
            expect(channel.send).not.toHaveBeenCalled();
        });
    });

    describe('runSignupAction', () => {
        it('should send progress message and edit with result on success', async () => {
            api.post.mockResolvedValueOnce({
                data: { success: true, data: { message: 'Signup started', status: 'running' } }
            });
            api.get.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        status: 'completed',
                        event_title: 'Open Play - Social / Low Intermediate',
                        matched_time: '7:00pm - 9:00pm',
                        spots_left: 4,
                        event_url: 'https://example.com/event'
                    }
                }
            });

            const channel = createMockChannel();
            await pickleball.runSignupAction(channel);

            // Should have sent initial "started" message
            expect(channel.send).toHaveBeenCalledWith('Pickleball signup started...');
            // Should have polled status
            expect(api.get).toHaveBeenCalledWith('/api/v1/pickleball/status');
            // Should have edited with result
            const sentMsg = channel._sent[0];
            expect(sentMsg.edit).toHaveBeenCalledWith(expect.stringContaining('Signup Complete'));
            expect(sentMsg.edit).toHaveBeenCalledWith(expect.stringContaining('Open Play - Social / Low Intermediate'));
        });

        it('should report failure when API returns error', async () => {
            api.post.mockResolvedValueOnce({
                data: { success: false, error: { message: 'SIGNUP_ALREADY_RUNNING' } }
            });

            const channel = createMockChannel();
            await pickleball.runSignupAction(channel);

            expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('Failed to start'));
        });

        it('should edit message with error when signup fails', async () => {
            api.post.mockResolvedValueOnce({
                data: { success: true, data: { message: 'Signup started' } }
            });
            api.get.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: { status: 'failed', error: 'Event not found' }
                }
            });

            const channel = createMockChannel();
            await pickleball.runSignupAction(channel);

            const sentMsg = channel._sent[0];
            expect(sentMsg.edit).toHaveBeenCalledWith(expect.stringContaining('Signup Failed'));
            expect(sentMsg.edit).toHaveBeenCalledWith(expect.stringContaining('Event not found'));
        });
    });

    describe('runFindAction', () => {
        it('should send message with signup button on success', async () => {
            api.post.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        event_title: 'Open Play - Intermediate',
                        matched_time: '7:00pm - 9:00pm',
                        spots_left: 6,
                        signup_url: 'https://pickleballkingdom.podplay.app/community/events/abc/signup'
                    }
                }
            });

            const channel = createMockChannel();
            await pickleball.runFindAction(channel);

            expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Open Play - Intermediate'),
                components: expect.arrayContaining([
                    expect.objectContaining({
                        components: expect.arrayContaining([
                            expect.objectContaining({
                                _data: expect.objectContaining({
                                    label: 'Sign Up',
                                    url: 'https://pickleballkingdom.podplay.app/community/events/abc/signup'
                                })
                            })
                        ])
                    })
                ])
            }));
        });

        it('should include spots left and signup_opens_at when present', async () => {
            api.post.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        message: 'Event found — signup not yet open',
                        event_title: 'Open Play - Intermediate',
                        matched_time: '7:00pm - 9:00pm',
                        spots_left: 8,
                        signup_opens_at: '2026-02-16T19:59:57.797677+00:00',
                        signup_url: 'https://example.com/signup'
                    }
                }
            });

            const channel = createMockChannel();
            await pickleball.runFindAction(channel);

            const callArg = channel.send.mock.calls[0][0];
            expect(callArg.content).toContain('**Spots Left:** 8');
            expect(callArg.content).toContain('Signup opens at:');
        });

        it('should send error message when event not found', async () => {
            api.post.mockResolvedValueOnce({
                data: { success: false, error: { message: 'Could not find event' } }
            });

            const channel = createMockChannel();
            await pickleball.runFindAction(channel);

            expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('not found'));
        });

        it('should handle network errors gracefully', async () => {
            api.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const channel = createMockChannel();
            await pickleball.runFindAction(channel);

            expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
        });
    });

    describe('pollStatus', () => {
        it('should return completed status immediately when available', async () => {
            api.get.mockResolvedValueOnce({
                data: { success: true, data: { status: 'completed', event_title: 'Test' } }
            });

            const result = await pickleball.pollStatus(5000, 100);
            expect(result.status).toBe('completed');
        });

        it('should return failed status', async () => {
            api.get.mockResolvedValueOnce({
                data: { success: true, data: { status: 'failed', error: 'Something broke' } }
            });

            const result = await pickleball.pollStatus(5000, 100);
            expect(result.status).toBe('failed');
            expect(result.error).toBe('Something broke');
        });

        it('should poll until completion', async () => {
            api.get
                .mockResolvedValueOnce({ data: { success: true, data: { status: 'running' } } })
                .mockResolvedValueOnce({ data: { success: true, data: { status: 'running' } } })
                .mockResolvedValueOnce({ data: { success: true, data: { status: 'completed', event_title: 'Done' } } });

            const result = await pickleball.pollStatus(10000, 50);
            expect(result.status).toBe('completed');
            expect(api.get).toHaveBeenCalledTimes(3);
        });

        it('should timeout when status never resolves', async () => {
            api.get.mockResolvedValue({ data: { success: true, data: { status: 'running' } } });

            const result = await pickleball.pollStatus(200, 50);
            expect(result.status).toBe('timeout');
        });
    });
});
