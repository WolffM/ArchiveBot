const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { PermissionsBitField, AttachmentBuilder } = require('discord.js');
const helper = require('../utils/helper');

// Path to the color roles directory
const COLOR_ROLES_DIR = path.join(__dirname, '..', 'Resources');

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
        
        // Try to load from file first
        if (fs.existsSync(filePath)) {
            console.log(`Loading color roles from file for guild ${guild.id}`);
            return loadColorRoles(guild.id);
        }
        
        // If file doesn't exist, infer from guild roles
        console.log(`Color roles file not found for guild ${guild.id}, creating from existing server roles`);
        return await inferColorRolesFromGuild(guild);
    } catch (error) {
        console.error(`Error in loadOrInferColorRoles for guild ${guild.id}:`, error);
        throw new Error(`Failed to load color roles: ${error.message}. Please make sure there are colored roles in this server.`);
    }
}

/**
 * Gets a friendly name for common color hex values
 * @param {string} hexColor - The hex color
 * @returns {string} A friendly name or null if not a common color
 */
function getFriendlyColorName(hexColor) {
    // Standardize hex format
    const hex = hexColor.replace('#', '').toUpperCase();
    
    // Common color mappings
    const colorNames = {
        'FF0000': 'Red',
        'FF4500': 'OrangeRed',
        'FFA500': 'Orange',
        'FFFF00': 'Yellow',
        'FFFF00': 'Yellow',
        'FFFA07': 'LemonChiffon',
        '00FF00': 'Green',
        '00FFFF': 'Cyan',
        '0000FF': 'Blue',
        '800080': 'Purple',
        'FF00FF': 'Magenta',
        'FFC0CB': 'Pink',
        'FFB6C1': 'LightPink',
        'FF69B4': 'HotPink',
        'FA0767': 'LightSalmon', 
        '008080': 'Teal',
        'A52A2A': 'Brown',
        'BC8F8F': 'RosyBrown',
        'F0E68C': 'Khaki',
        'E6E6FA': 'Lavender',
        '20B2AA': 'LightSeaGreen',
        '3CB371': 'MediumSeaGreen',
        '66CDAA': 'MediumAquamarine',
        '9370DB': 'MediumPurple',
        '98FB98': 'PaleGreen',
        'AFEEEEE': 'PaleTurquoise',
        'CD853F': 'Peru',
        '00FF7F': 'SpringGreen',
        '6A5ACD': 'SlateBlue',
        '4682B4': 'SteelBlue',
        'D8BFD8': 'Thistle',
        'FF6347': 'Tomato',
        'EE82EE': 'Violet',
        'F5DEB3': 'Wheat',
        '87CEFA': 'LightSkyBlue',
        '4169E1': 'RoyalBlue',
        'DC143C': 'Crimson',
        '8B008B': 'DarkMagenta',
        'FFFFFF': 'White',
        '000000': 'Black',
        'DCDCDC': 'Gainsboro',
        'CD5C5C': 'IndianRed',
        'DC5349': 'DeepSpaceRed',
        '00FFFF': 'Aqua'
    };
    
    return colorNames[hex] || null;
}

/**
 * Creates a new color role for a guild
 * @param {Object} guild - Discord.js Guild object
 * @param {string} hexColor - The hex color for the role
 * @returns {Promise<Object>} The created role data
 */
async function createColorRole(guild, hexColor) {
    // Generate a role name based on the hex color
    const friendlyName = getFriendlyColorName(hexColor);
    let roleName = friendlyName || `Color-${hexColor.replace('#', '')}`;
    
    try {
        console.log(`Creating new color role with name: ${roleName}, color: ${hexColor}`);
        
        // Find the lowest position of existing color roles
        const colorRoles = await loadOrInferColorRoles(guild);
        const botMember = guild.members.cache.get(guild.client.user.id);
        const botRolePosition = botMember?.roles?.highest?.position || 0;
        
        // Calculate position for the new role - directly above the bot's highest role
        // or directly below existing color roles if any exist
        let position = botRolePosition;
        
        // Get existing color role IDs from our data
        const colorRoleIds = colorRoles.roles
            .filter(role => role.id)
            .map(role => role.id);
        
        // Find the position of existing color roles in the guild
        if (colorRoleIds.length > 0) {
            const existingColorRoles = guild.roles.cache
                .filter(role => colorRoleIds.includes(role.id));
                
            if (existingColorRoles.size > 0) {
                // Find the highest position among existing color roles
                // We'll place the new role at that position to maintain order
                const highestPosition = Math.max(...existingColorRoles.map(role => role.position));
                position = highestPosition;
                console.log(`Found existing color roles, using position: ${position}`);
            }
        }
        
        // Create the role in Discord at the determined position
        const newRole = await guild.roles.create({
            name: roleName,
            color: hexColor,
            reason: 'User requested custom color',
            permissions: [],
            position: position // This will try to set the role at this position
        });
        
        console.log(`Successfully created role in Discord with ID: ${newRole.id}`);
        
        // Update our color roles data
        const updatedColorRoles = await loadOrInferColorRoles(guild);
        
        // Add the new role to our color roles
        updatedColorRoles.roles.push({
            name: roleName,
            hexColor: hexColor,
            id: newRole.id
        });
        
        // Save the updated color roles to disk
        saveColorRoles(guild.id, updatedColorRoles);
        console.log(`Updated colorRoles.json with new role: ${roleName} (${hexColor})`);
        
        // Verify the role was saved
        const verifyColorRoles = loadColorRoles(guild.id);
        const savedRole = verifyColorRoles.roles.find(r => r.id === newRole.id);
        
        if (!savedRole) {
            console.warn(`Warning: Role ${newRole.id} was created but may not have been saved properly.`);
        } else {
            console.log(`Verified role was saved successfully: ${savedRole.name} (${savedRole.hexColor})`);
        }
        
        return {
            name: roleName,
            hexColor: hexColor,
            id: newRole.id
        };
    } catch (error) {
        console.error('Error creating color role:', error);
        throw new Error(`Failed to create color role: ${error.message}`);
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
 * Convert hex color to HSL (Hue, Saturation, Lightness)
 * @param {string} hexColor - Hex color code
 * @returns {Object} HSL values
 */
function hexToHSL(hexColor) {
    // Remove the hash if present
    const hex = hexColor.replace('#', '');
    
    // Parse RGB values
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    
    let h, s, l = (max + min) / 2;
    
    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        
        h /= 6;
    }
    
    return { h, s, l };
}

/**
 * Sorts colors by HSL values for a smooth color transition
 * @param {Array} colors - Array of color roles
 * @returns {Array} Sorted colors
 */
function sortColorsByHSL(colors) {
    return [...colors].sort((a, b) => {
        const aHSL = hexToHSL(a.hexColor);
        const bHSL = hexToHSL(b.hexColor);
        
        // First sort by hue
        if (Math.abs(aHSL.h - bHSL.h) > 0.05) {
            return aHSL.h - bHSL.h;
        }
        
        // Then by saturation
        if (Math.abs(aHSL.s - bHSL.s) > 0.1) {
            return bHSL.s - aHSL.s;
        }
        
        // Finally by lightness
        return bHSL.l - aHSL.l;
    });
}

/**
 * Generates an image displaying available colors
 * @param {Array} roles - Array of color roles
 * @returns {Buffer} Image buffer
 */
async function generateColorImage(roles) {
    // Sort roles by color similarity instead of alphabetically
    const sortedRoles = sortColorsByHSL(roles);
    
    // Layout configuration
    const COLUMNS = 3;
    const ROWS = Math.ceil(sortedRoles.length / COLUMNS);
    const PADDING = 15;
    const COLOR_HEIGHT = 30;
    const TOP_PADDING = 20;
    const WIDTH = 800;
    
    // Calculate canvas height based on number of rows
    const HEIGHT = TOP_PADDING + (ROWS * COLOR_HEIGHT) + (PADDING * 2);
    
    // Create canvas
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    
    // Fill background
    ctx.fillStyle = '#2f3136';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    
    // Calculate column width
    const colWidth = (WIDTH - (PADDING * 2)) / COLUMNS;
    
    // Draw color entries
    sortedRoles.forEach((role, index) => {
        const row = Math.floor(index / COLUMNS);
        const col = index % COLUMNS;
        
        const x = PADDING + (col * colWidth);
        const y = TOP_PADDING + (row * COLOR_HEIGHT);
        
        // Index number
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'left';
        ctx.fillText(`${index + 1}.`, x, y + 20);
        
        // Color name in its color
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = role.hexColor;
        ctx.fillText(` ${role.name}`, x + 25, y + 20);
    });
    
    // Convert to buffer
    return canvas.toBuffer('image/png');
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
        
        // Filter out roles without IDs and check if we have any roles
        const validRoles = colorRoles.roles.filter(role => role.id);
        if (validRoles.length === 0) {
            await interaction.editReply('No color roles are currently set up on this server.');
            return;
        }
        
        // Generate color image
        const colorImage = await generateColorImage(validRoles);
        
        // Create attachment
        const attachment = new AttachmentBuilder(colorImage, { name: 'colors.png' });
        
        // Build message content
        let messageContent = '# Available Colors\n';
        messageContent += 'Choose a color using:\n';
        messageContent += '• `/color [name]` - e.g., `/color SeaGreen`\n';
        messageContent += '• `/color [number]` - e.g., `/color 22`\n';
        messageContent += '• `/color [hex]` - e.g., `/color #FF5733`\n';
        
        // Send the reply with the image
        await interaction.editReply({
            content: messageContent,
            files: [attachment]
        });
    } catch (error) {
        console.error('Error handling colorshow command:', error);
        await interaction.editReply('An error occurred while showing available colors. Please try again later or contact a server admin.');
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
        
        // Sort roles the same way they're displayed in colorshow
        const validRoles = colorRoles.roles.filter(role => role.id);
        const sortedRoles = sortColorsByHSL(validRoles);
        
        // Check if the identifier is a number (index from colorshow)
        let role = null;
        const numberMatch = identifier.match(/^(\d+)$/);
        
        if (numberMatch) {
            // Convert to integer and subtract 1 for 0-based index
            const index = parseInt(numberMatch[1], 10) - 1;
            
            // Check if the index is valid
            if (index >= 0 && index < sortedRoles.length) {
                console.log(`Found color by index: ${index + 1}, which is ${sortedRoles[index].name}`);
                role = sortedRoles[index];
            } else {
                await interaction.editReply(`Invalid color number. Please choose a number between 1 and ${sortedRoles.length}.`);
                return;
            }
        } else {
            // Try to find by name, id, or hex as before
            role = findColorRole(colorRoles, identifier);
        }
        
        if (!role) {
            await interaction.editReply('Color not found. Please provide a valid color name, role ID, hex color, or number from `/colorshow`.');
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

module.exports = {
    handleColorCommand,
    handleColorShowCommand,
    loadOrInferColorRoles,
    findColorRole,
    createColorRole,
    removeExistingColorRoles,
    // Pure functions exported for testing
    hexToHSL,
    sortColorsByHSL,
    getFriendlyColorName,
}; 