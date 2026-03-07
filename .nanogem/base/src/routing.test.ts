import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('Discord channel JID: starts with discord-', () => {
    const jid = 'discord-12345678';
    expect(jid.startsWith('discord-')).toBe(true);
  });

  it('Discord DM JID: starts with discord-', () => {
    const jid = 'discord-12345678';
    expect(jid.startsWith('discord-')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'discord-group1',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'discord',
      true,
    );
    storeChatMetadata(
      'discord-user',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'discord',
      false,
    );
    storeChatMetadata(
      'discord-group2',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('discord-group1');
    expect(groups.map((g) => g.jid)).toContain('discord-group2');
    expect(groups.map((g) => g.jid)).not.toContain('discord-user');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'discord-group',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('discord-group');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'discord-reg',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'discord',
      true,
    );
    storeChatMetadata(
      'discord-unreg',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'discord',
      true,
    );

    _setRegisteredGroups({
      'discord-reg': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'discord-reg');
    const unreg = groups.find((g) => g.jid === 'discord-unreg');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'discord-old',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'discord',
      true,
    );
    storeChatMetadata(
      'discord-new',
      '2024-01-01T00:00:05.000Z',
      'New',
      'discord',
      true,
    );
    storeChatMetadata(
      'discord-mid',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('discord-new');
    expect(groups[1].jid).toBe('discord-mid');
    expect(groups[2].jid).toBe('discord-old');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'discord-group',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('discord-group');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
