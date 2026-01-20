const fs = require('fs');
const path = require('path');
const helper = require('../utils/helper');
const { createLogger } = require('../utils/logger');

const log = createLogger('permissions');

// Path to store permissions
const PERMISSIONS_DIR = path.join(__dirname, '..', 'Resources');

/**
 * Get path to permissions file for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {string} Path to permissions file
 */
function getPermissionsFilePath(guildId) {
    return path.join(PERMISSIONS_DIR, guildId, 'permissions.json');
}

/**
 * Ensure directory exists
 * @param {string} guildId - The Discord guild ID
 * @returns {string} Guild directory path
 */
function ensureGuildDirectory(guildId) {
    const guildPath = path.join(PERMISSIONS_DIR, guildId);
    helper.ensureDirectoryExists(guildPath);
    return guildPath;
}

/**
 * Initialize permissions for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Object} Default permissions structure
 */
function initializePermissions(guildId) {
    const defaultPermissions = {
        adminUsers: [],     // User IDs with admin access
        taskUsers: [],      // User IDs with task system access
        lastUpdated: new Date().toISOString()
    };
    
    savePermissions(guildId, defaultPermissions);
    return defaultPermissions;
}

/**
 * Load permissions for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Object} Permissions data
 */
function loadPermissions(guildId) {
    ensureGuildDirectory(guildId);
    const filePath = getPermissionsFilePath(guildId);
    
    if (!fs.existsSync(filePath)) {
        return initializePermissions(guildId);
    }
    
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Save permissions to disk
 * @param {string} guildId - The Discord guild ID
 * @param {Object} permissions - Permissions data to save
 */
function savePermissions(guildId, permissions) {
    ensureGuildDirectory(guildId);
    const filePath = getPermissionsFilePath(guildId);
    
    // Update timestamp
    permissions.lastUpdated = new Date().toISOString();
    
    // Write to disk
    fs.writeFileSync(filePath, JSON.stringify(permissions, null, 2));
}

/**
 * Check if a user has admin permissions
 * @param {string} userId - The user ID to check
 * @param {string} guildId - The Discord guild ID
 * @returns {boolean} Whether the user is an admin
 */
function isAdmin(userId, guildId) {
    // Check guild-specific admins
    const permissions = loadPermissions(guildId);
    return permissions.adminUsers.includes(userId);
}

/**
 * Check if a user has task system access
 * @param {string} userId - The user ID to check
 * @param {string} guildId - The Discord guild ID
 * @returns {boolean} Whether the user has task access
 */
function hasTaskAccess(userId, guildId) {
    // Check if admin (admins always have task access)
    if (isAdmin(userId, guildId)) {
        return true;
    }
    
    // Check task-specific permissions
    const permissions = loadPermissions(guildId);
    return permissions.taskUsers.includes(userId);
}

/**
 * Check if a user has a specific role in a guild
 * @param {Object} member - Discord.js GuildMember object
 * @param {string} roleName - Name of the role to check
 * @returns {boolean} Whether the user has the role
 */
function hasRole(member, roleName) {
    if (!member || !member.roles) {
        return false;
    }
    
    return member.roles.cache.some(
        role => role.name.toLowerCase() === roleName.toLowerCase()
    );
}

/**
 * Checks if a user has admin permissions through either permissions.json or role
 * @param {string} userId - The user ID to check
 * @param {Object} guild - Discord.js Guild object
 * @returns {Promise<boolean>} Whether the user has admin access
 */
async function hasAdminAccess(userId, guild) {
    // Check our permission system first
    if (isAdmin(userId, guild.id)) {
        return true;
    }
    
    try {
        // Check for admin role
        const member = await guild.members.fetch(userId);
        return hasRole(member, 'admin');
    } catch (error) {
        log.error('hasAdminAccess', error, { userId, guildId: guild.id });
        return false;
    }
}

/**
 * Checks if a user has task permissions through either permissions.json or role
 * @param {string} userId - The user ID to check
 * @param {Object} guild - Discord.js Guild object
 * @returns {Promise<boolean>} Whether the user has task access
 */
async function checkTaskAccessWithRoles(userId, guild) {
    // Check our permission system first - use the file-based function
    if (hasTaskAccess(userId, guild.id)) {
        return true;
    }
    
    try {
        // Check for task role or admin role (admins have task access)
        const member = await guild.members.fetch(userId);
        return hasRole(member, 'task') || hasRole(member, 'admin');
    } catch (error) {
        log.error('checkTaskAccessWithRoles', error, { userId, guildId: guild.id });
        return false;
    }
}

/**
 * Get the role ID for a specific permission type in a guild
 * @param {Object} guild - Discord.js Guild object
 * @param {string} permissionType - The permission type ('admin' or 'task')
 * @returns {string|null} The role ID or null if not found
 */
function getPermissionRole(guild, permissionType) {
    const roleName = permissionType === 'admin' ? 'admin' : 'task';
    const role = guild.roles.cache.find(r => 
        r.name.toLowerCase() === roleName.toLowerCase());
    return role ? role.id : null;
}

/**
 * Add a user to a permission group and assign the corresponding role
 * @param {string} userId - The user ID to add
 * @param {Object} guild - Discord.js Guild object
 * @param {string} permissionType - The permission type ('admin' or 'task')
 * @returns {Promise<Object>} Result of the operation
 */
async function addUserPermission(userId, guild, permissionType) {
    try {
        const guildId = guild.id;
        const permissions = loadPermissions(guildId);
        
        let wasAdded = false;
        
        // Add to permission file
        if (permissionType === 'admin') {
            if (!permissions.adminUsers.includes(userId)) {
                permissions.adminUsers.push(userId);
                wasAdded = true;
            }
        } else if (permissionType === 'task') {
            if (!permissions.taskUsers.includes(userId)) {
                permissions.taskUsers.push(userId);
                wasAdded = true;
            }
        } else {
            throw new Error(`Unknown permission type: ${permissionType}`);
        }
        
        if (wasAdded) {
            savePermissions(guildId, permissions);
        }
        
        // Assign role if it exists
        const roleId = getPermissionRole(guild, permissionType);
        let roleAssigned = false;
        
        if (roleId) {
            try {
                const member = await guild.members.fetch(userId);
                if (member && !member.roles.cache.has(roleId)) {
                    await member.roles.add(roleId, `Assigned ${permissionType} permission via bot`);
                    roleAssigned = true;
                }
            } catch (roleError) {
                log.error('addUserPermission', roleError, { userId, guildId, permissionType, phase: 'assign role' });
                // We'll continue even if role assignment fails
            }
        }
        
        return {
            success: wasAdded || roleAssigned,
            permissionAdded: wasAdded,
            roleAssigned: roleAssigned,
            hadPermissionAlready: !wasAdded && permissions[permissionType === 'admin' ? 'adminUsers' : 'taskUsers'].includes(userId)
        };
        log.success('addUserPermission', {
            userId,
            guildId,
            permissionType,
            permissionAdded: wasAdded,
            roleAssigned
        });

        return {
            success: wasAdded || roleAssigned,
            permissionAdded: wasAdded,
            roleAssigned: roleAssigned,
            hadPermissionAlready: !wasAdded && permissions[permissionType === 'admin' ? 'adminUsers' : 'taskUsers'].includes(userId)
        };
    } catch (error) {
        log.error('addUserPermission', error, { userId, guildId, permissionType });
        throw error;
    }
}

/**
 * Remove a user from a permission group and the corresponding role
 * @param {string} userId - The user ID to remove
 * @param {Object} guild - Discord.js Guild object
 * @param {string} permissionType - The permission type ('admin' or 'task')
 * @returns {Promise<Object>} Result of the operation
 */
async function removeUserPermission(userId, guild, permissionType) {
    try {
        const guildId = guild.id;
        const permissions = loadPermissions(guildId);
        
        let wasRemoved = false;
        
        // Remove from permission file
        if (permissionType === 'admin') {
            const index = permissions.adminUsers.indexOf(userId);
            if (index !== -1) {
                permissions.adminUsers.splice(index, 1);
                wasRemoved = true;
            }
        } else if (permissionType === 'task') {
            const index = permissions.taskUsers.indexOf(userId);
            if (index !== -1) {
                permissions.taskUsers.splice(index, 1);
                wasRemoved = true;
            }
        } else {
            throw new Error(`Unknown permission type: ${permissionType}`);
        }
        
        if (wasRemoved) {
            savePermissions(guildId, permissions);
        }
        
        // Remove role if it exists
        const roleId = getPermissionRole(guild, permissionType);
        let roleRemoved = false;
        
        if (roleId) {
            try {
                const member = await guild.members.fetch(userId);
                if (member && member.roles.cache.has(roleId)) {
                    await member.roles.remove(roleId, `Removed ${permissionType} permission via bot`);
                    roleRemoved = true;
                }
            } catch (roleError) {
                log.error('removeUserPermission', roleError, { userId, guildId, permissionType, phase: 'remove role' });
                // We'll continue even if role removal fails
            }
        }
        
        return {
            success: wasRemoved || roleRemoved,
            permissionRemoved: wasRemoved,
            roleRemoved: roleRemoved,
            didNotHavePermission: !wasRemoved && !permissions[permissionType === 'admin' ? 'adminUsers' : 'taskUsers'].includes(userId)
        };
        log.success('removeUserPermission', {
            userId,
            guildId,
            permissionType,
            permissionRemoved: wasRemoved,
            roleRemoved
        });

        return {
            success: wasRemoved || roleRemoved,
            permissionRemoved: wasRemoved,
            roleRemoved: roleRemoved,
            didNotHavePermission: !wasRemoved && !permissions[permissionType === 'admin' ? 'adminUsers' : 'taskUsers'].includes(userId)
        };
    } catch (error) {
        log.error('removeUserPermission', error, { userId, guildId, permissionType });
        throw error;
    }
}

/**
 * Get list of users with specified permission
 * @param {string} guildId - The Discord guild ID
 * @param {string} permissionType - The permission type ('admin' or 'task')
 * @returns {Array} Array of user IDs with the permission
 */
function getUsersWithPermission(guildId, permissionType) {
    const permissions = loadPermissions(guildId);
    
    if (permissionType === 'admin') {
        return [...permissions.adminUsers];
    } else if (permissionType === 'task') {
        return [...permissions.taskUsers];
    } else {
        throw new Error(`Unknown permission type: ${permissionType}`);
    }
}

/**
 * Trigger command re-registration after permission changes
 * @param {Object} guild - The guild where permissions were updated
 */
async function triggerCommandRefresh(guild) {
    // Emit a custom event that can be caught in index.js
    const refreshEvent = new CustomEvent('permissionsUpdated', { 
        detail: { 
            guildId: guild.id 
        } 
    });
    
    log.info('triggerCommandRefresh', { guildId: guild.id, guildName: guild.name });
    
    // Emit the event if we're in a browser environment
    if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(refreshEvent);
    }
    
    // For Node.js, we'll use the module.exports to signal this
    return {
        guildId: guild.id,
        needsRefresh: true
    };
}

/**
 * Set or remove a permission for a user
 * @param {string} userId - The ID of the user
 * @param {string} guildId - The ID of the guild
 * @param {string} permissionType - The type of permission ('admin' or 'task')
 * @param {boolean} remove - Whether to remove the permission (default: false)
 * @returns {Object} Result of the operation
 */
function setPermission(userId, guildId, permissionType, remove = false) {
    // Normalize permission type to lowercase
    const normalizedType = permissionType.toLowerCase();

    // Load existing permissions (uses correct path via PERMISSIONS_DIR)
    const permissions = loadPermissions(guildId);

    // Determine which array to modify (use consistent property names)
    const arrayName = normalizedType === 'admin' ? 'adminUsers' : 'taskUsers';
    const permissionArray = permissions[arrayName];
    const userIndex = permissionArray.indexOf(userId);

    let changed = false;

    // Add or remove the user
    if (remove) {
        if (userIndex !== -1) {
            permissionArray.splice(userIndex, 1);
            changed = true;
            log.success('setPermission', { action: 'remove', userId, guildId, permissionType: normalizedType });
        }
    } else {
        if (userIndex === -1) {
            permissionArray.push(userId);
            changed = true;
            log.success('setPermission', { action: 'add', userId, guildId, permissionType: normalizedType });
        }
    }

    // Save if changed
    if (changed) {
        savePermissions(guildId, permissions);
    }

    // Return result indicating if commands need refresh
    return {
        success: true,
        changed,
        needsRefresh: changed
    };
}

/**
 * Get role IDs for admin and task roles in a guild
 * @param {Object} guild - Discord.js Guild object
 * @returns {Object} Object containing adminRoleId and taskRoleId (null if not found)
 */
function loadRoleIds(guild) {
    const adminRoleId = getPermissionRole(guild, 'admin');
    const taskRoleId = getPermissionRole(guild, 'task');
    return { adminRoleId, taskRoleId };
}

// Export functions
module.exports = {
    isAdmin,
    hasTaskAccess,
    addUserPermission,
    removeUserPermission,
    getUsersWithPermission,
    loadPermissions,
    hasRole,
    hasAdminAccess,
    checkTaskAccessWithRoles,
    triggerCommandRefresh,
    setPermission,
    loadRoleIds,
    getPermissionRole
}; 