const fs = require('fs');
const path = require('path');
const { PermissionsBitField, EmbedBuilder } = require('discord.js');
const helper = require('./helper');

// Path to the color roles directory
const COLOR_ROLES_DIR = path.join(__dirname, 'Resources');

/**
 * Gets the path to the color roles JSON file for a specific guild
 * @param {string} guildId - The Discord guild ID
 * @returns {string} The path to the color roles JSON file
 */
function getColorRolesFilePath(guildId) {
    return path.join(COLOR_ROLES_DIR, guildId, 'colorRoles.json');
}

/**
 * Ensures the directory for a guild exists
 * @param {string} guildId - The Discord guild ID
 * @returns {string} The path to the guild directory
 */
function ensureGuildDirectory(guildId) {
    const guildPath = path.join(COLOR_ROLES_DIR, guildId);
    helper.ensureDirectoryExists(guildPath);
    return guildPath;
}

/**
 * Loads color roles from the JSON file
 * @param {string} guildId - The Discord guild ID
 * @returns {Object} Color roles data
 */
function loadColorRoles(guildId) {
    ensureGuildDirectory(guildId);
    const filePath = getColorRolesFilePath(guildId);
    
    if (!fs.existsSync(filePath)) {
        throw new Error(`Color roles file not found for guild ${guildId}. Please set up color roles first.`);
    }
    
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Saves color roles to the JSON file
 * @param {string} guildId - The Discord guild ID
 * @param {Object} colorRoles - The color roles data to save
 */
function saveColorRoles(guildId, colorRoles) {
    ensureGuildDirectory(guildId);
    const filePath = getColorRolesFilePath(guildId);
    fs.writeFileSync(filePath, JSON.stringify(colorRoles, null, 2));
}

/**
 * Finds a color role by name, id, or hex color
 * @param {Object} colorRoles - The color roles data
 * @param {string} identifier - The identifier to search for (name, id, or hex color)
 * @returns {Object|null} The found role or null
 */
function findColorRole(colorRoles, identifier) {
    if (!identifier) return null;
    
    const lowerIdentifier = identifier.toLowerCase();
    
    // First, try to find by ID, name, or hex color (exact match)
    for (const role of colorRoles.roles) {
        if (
            role.id === identifier || 
            role.name.toLowerCase() === lowerIdentifier ||
            role.hexColor.toLowerCase() === lowerIdentifier
        ) {
            return role;
        }
    }
    
    // If not found, check if it's a hex color
    const hexColorRegex = /^#?([0-9A-F]{6}|[0-9A-F]{3})$/i;
    if (hexColorRegex.test(identifier)) {
        // Format hex color with leading #
        const formattedHex = identifier.startsWith('#') ? identifier : `#${identifier}`;
        return { name: null, hexColor: formattedHex.toUpperCase(), id: null };
    }
    
    return null;
}

/**
 * Infers color roles from existing guild roles
 * @param {Object} guild - Discord.js Guild object
 * @returns {Promise<Object>} The inferred color roles data
 */
async function inferColorRolesFromGuild(guild) {
    ensureGuildDirectory(guild.id);
    
    // Initialize with empty roles array
    const colorRoles = { roles: [] };
    
    // Default Discord color is 0 (no color)
    const defaultColor = 0;
    
    // Filter roles that have a non-default color
    const coloredRoles = guild.roles.cache.filter(role => 
        role.color !== defaultColor && 
        !role.managed && // Exclude integration roles (bots, etc.)
        role.name !== '@everyone'
    );
    
    // If there are no colored roles, throw an error
    if (coloredRoles.size === 0) {
        throw new Error('No colored roles found in the server. Please create some roles with colors first.');
    }
    
    // Loop through colored roles in the guild
    coloredRoles.forEach(role => {
        // Convert Discord's decimal color to hex
        const hexColor = `#${role.color.toString(16).padStart(6, '0').toUpperCase()}`;
        
        // Add the role to our list
        colorRoles.roles.push({
            name: role.name,
            hexColor: hexColor,
            id: role.id
        });
    });
    
    // Save the inferred roles
    saveColorRoles(guild.id, colorRoles);
    
    return colorRoles;
}

/**
 * Loads or infers color roles for a guild
 * @param {Object} guild - Discord.js Guild object
 * @returns {Promise<Object>} The color roles data
 */
async function loadOrInferColorRoles(guild) {
    try {
        const filePath = getColorRolesFilePath(guild.id);
        ensureGuildDirectory(guild.id);
        
        console.log(`Checking for color roles file at: ${filePath}`);
        
        if (!fs.existsSync(filePath)) {
            console.log(`Color roles file not found for guild ${guild.id}, creating from existing server roles`);
            try {
                return await inferColorRolesFromGuild(guild);
            } catch (inferError) {
                console.error('Error inferring roles from guild:', inferError);
                throw new Error(`Could not create color roles file: ${inferError.message}`);
            }
        }
        
        console.log(`Loading color roles from file for guild ${guild.id}`);
        try {
            return loadColorRoles(guild.id);
        } catch (loadError) {
            console.error('Error loading color roles from file:', loadError);
            throw new Error(`Could not load color roles: ${loadError.message}`);
        }
    } catch (error) {
        console.error(`Error in loadOrInferColorRoles for guild ${guild.id}:`, error);
        throw new Error(`Failed to load color roles: ${error.message}. Please make sure there are colored roles in this server.`);
    }
}

/**
 * Creates a new color role for a guild
 * @param {Object} guild - Discord.js Guild object
 * @param {string} hexColor - The hex color for the role
 * @returns {Promise<Object>} The created role data
 */
async function createColorRole(guild, hexColor) {
    // Generate a role name based on the hex color
    let roleName = `Color-${hexColor.replace('#', '')}`;
    
    try {
        // Create the role in Discord
        const newRole = await guild.roles.create({
            name: roleName,
            color: hexColor,
            reason: 'User requested custom color',
            permissions: []
        });
        
        // Update our color roles data
        const colorRoles = await loadOrInferColorRoles(guild);
        colorRoles.roles.push({
            name: roleName,
            hexColor: hexColor,
            id: newRole.id
        });
        saveColorRoles(guild.id, colorRoles);
        
        return {
            name: roleName,
            hexColor: hexColor,
            id: newRole.id
        };
    } catch (error) {
        console.error('Error creating color role:', error);
        throw new Error('Failed to create color role. Please check bot permissions.');
    }
}

/**
 * Removes all color roles from a member
 * @param {Object} member - Discord.js GuildMember object
 * @param {Object} colorRoles - The color roles data
 * @returns {Promise<void>}
 */
async function removeExistingColorRoles(member, colorRoles) {
    try {
        // Get all the color role IDs we track
        const colorRoleIds = colorRoles.roles
            .filter(role => role.id)
            .map(role => role.id);
        
        if (colorRoleIds.length === 0) {
            console.log('No color roles to remove (empty ID list)');
            return;
        }
        
        // Get the intersection of member roles and color roles
        const rolesToRemove = member.roles.cache
            .filter(role => colorRoleIds.includes(role.id))
            .map(role => role.id);
        
        if (rolesToRemove.length > 0) {
            console.log(`Removing ${rolesToRemove.length} color roles from ${member.user.tag}: ${rolesToRemove.join(', ')}`);
            await member.roles.remove(rolesToRemove, 'Changing color role');
            console.log('Successfully removed color roles');
        } else {
            console.log(`No color roles to remove for ${member.user.tag}`);
        }
    } catch (error) {
        console.error('Error removing existing color roles:', error);
        throw new Error(`Failed to remove existing color roles: ${error.message}`);
    }
}

/**
 * Checks if bot has necessary permissions to manage roles
 * @param {Object} interaction - Discord.js CommandInteraction object
 * @returns {boolean} Whether the bot has permission to manage roles
 */
async function checkBotPermissions(interaction) {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return false;
    }
    
    const botMember = interaction.guild.members.cache.get(interaction.client.user.id);
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        await interaction.reply({ 
            content: 'I don\'t have permission to manage roles in this server. Please ask an admin to give me the "Manage Roles" permission.', 
            ephemeral: true 
        });
        return false;
    }
    
    return true;
}

/**
 * Handles the process of applying a color role to a member
 * @param {Object} interaction - Discord.js CommandInteraction object
 * @param {Object} role - The color role to apply
 * @param {Object} colorRoles - All available color roles 
 * @returns {Promise<boolean>} Whether the operation was successful
 */
async function applyColorRole(interaction, role, colorRoles) {
    try {
        // Remove existing color roles
        console.log(`Removing existing color roles for user: ${interaction.user.tag}`);
        await removeExistingColorRoles(interaction.member, colorRoles);
        
        // Add the new color role
        console.log(`Adding new color role: ${role.name || role.hexColor} (ID: ${role.id})`);
        await interaction.member.roles.add(role.id, 'User changed color');
        
        await interaction.editReply(`Your color has been set to ${role.name || role.hexColor}!`);
        return true;
    } catch (error) {
        console.error('Error applying color role:', error);
        await interaction.editReply(`Error changing your color: ${error.message}`);
        return false;
    }
}

/**
 * Handles the /color command
 * @param {Object} interaction - Discord.js CommandInteraction object
 */
async function handleColorCommand(interaction) {
    // Check permissions
    if (!await checkBotPermissions(interaction)) {
        return;
    }
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
        console.log(`Processing color command for guild: ${interaction.guild.id}`);
        
        const identifier = interaction.options.getString('color');
        if (!identifier) {
            await interaction.editReply('Please provide a color name, role ID, or hex color (e.g., #FF0000).');
            return;
        }
        
        console.log(`Requested color: ${identifier}`);
        ensureGuildDirectory(interaction.guild.id);
        
        // Load color roles
        let colorRoles;
        try {
            colorRoles = await loadOrInferColorRoles(interaction.guild);
        } catch (error) {
            console.error('Failed to load color roles:', error);
            if (error.message.includes('No colored roles found')) {
                await interaction.editReply('There are no colored roles in this server. Please ask a server admin to create some roles with colors first.');
            } else {
                await interaction.editReply(`Error: ${error.message}`);
            }
            return;
        }
        
        // Find or create the role
        let role = findColorRole(colorRoles, identifier);
        if (!role) {
            await interaction.editReply('Color not found. Please provide a valid color name, role ID, or hex color.');
            return;
        }
        
        // Handle new hex color or missing role
        if (!role.id || !interaction.guild.roles.cache.get(role.id)) {
            try {
                const action = !role.id ? 'Creating' : 'Recreating';
                console.log(`${action} color role for: ${role.hexColor}`);
                role = await createColorRole(interaction.guild, role.hexColor);
            } catch (error) {
                console.error('Error creating color role:', error);
                await interaction.editReply(`Error creating color role: ${error.message}`);
                return;
            }
        }
        
        // Apply the role
        await applyColorRole(interaction, role, colorRoles);
    } catch (error) {
        console.error('Error handling color command:', error);
        await interaction.editReply('An error occurred while changing your color. Please try again later or contact a server admin.');
    }
}

/**
 * Handles the /colorshow command
 * @param {Object} interaction - Discord.js CommandInteraction object
 */
async function handleColorShowCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    try {
        console.log(`Processing colorshow command for guild: ${interaction.guild.id}`);
        ensureGuildDirectory(interaction.guild.id);
        
        // Load color roles
        let colorRoles;
        try {
            colorRoles = await loadOrInferColorRoles(interaction.guild);
        } catch (error) {
            console.error('Failed to load color roles for colorshow:', error);
            if (error.message.includes('No colored roles found')) {
                await interaction.editReply('There are no colored roles in this server. Please ask a server admin to create some roles with colors first.');
            } else {
                await interaction.editReply(`Error loading colors: ${error.message}`);
            }
            return;
        }
        
        // Create the color display embed
        const embed = new EmbedBuilder()
            .setTitle('Available Colors')
            .setDescription('Choose a color using `/color [name or hex]`')
            .setColor('#2f3136');
        
        // Build color list
        let colorList = '';
        for (const role of colorRoles.roles) {
            if (role.id) {
                colorList += `• **${role.name}** (${role.hexColor})\n`;
            }
        }
        
        // Add color fields to embed
        if (colorList) {
            embed.addFields({ name: 'Available Colors', value: colorList });
        } else {
            embed.addFields({ name: 'Available Colors', value: 'No color roles are currently set up on this server.' });
        }
        
        embed.addFields({ 
            name: 'Custom Colors', 
            value: 'You can also specify a custom color using a hex code like `#FF5733`.\nFind hex colors at https://htmlcolorcodes.com/'
        });
        
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Error handling colorshow command:', error);
        await interaction.editReply('An error occurred while showing available colors. Please try again later or contact a server admin.');
    }
}

module.exports = {
    handleColorCommand,
    handleColorShowCommand,
    loadOrInferColorRoles,
    findColorRole,
    createColorRole,
    removeExistingColorRoles
}; 