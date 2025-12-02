/**
 * Telegram Account Preset Manager
 * Handles saving, loading, and managing multiple Telegram account credentials
 */

class TelegramPresetManager {
    constructor() {
        this.presetSelect = document.getElementById('telegram-preset-select');
        this.saveBtn = document.getElementById('save-preset-btn');
        this.deleteBtn = document.getElementById('delete-preset-btn');
        this.apiIdInput = document.getElementById('telegram-api-id');
        this.apiHashInput = document.getElementById('telegram-api-hash');
        this.phoneInput = document.getElementById('telegram-phone');

        this.initializeEventListeners();
        this.loadPresets();
    }

    initializeEventListeners() {
        // Preset selection change
        this.presetSelect.addEventListener('change', () => this.onPresetSelect());

        // Save button click
        this.saveBtn.addEventListener('click', () => this.savePreset());

        // Delete button click
        this.deleteBtn.addEventListener('click', () => this.deletePreset());
    }

    async loadPresets() {
        try {
            const response = await fetch('http://localhost:5000/api/presets/list');
            const data = await response.json();

            if (data.success) {
                this.populatePresetDropdown(data.presets);
            }
        } catch (error) {
            console.error('Failed to load presets:', error);
        }
    }

    populatePresetDropdown(presets) {
        // Clear existing options except the first one
        this.presetSelect.innerHTML = '<option value="">-- Select Preset --</option>';

        // Add preset options
        presets.forEach(presetName => {
            const option = document.createElement('option');
            option.value = presetName;
            option.textContent = presetName;
            this.presetSelect.appendChild(option);
        });
    }

    async onPresetSelect() {
        const selectedPreset = this.presetSelect.value;

        // Enable/disable delete button
        this.deleteBtn.disabled = !selectedPreset;

        if (!selectedPreset) return;

        // Check if connected - prevent switching while connected
        if (this.isConnected()) {
            window.app.showToast('error', 'Cannot Switch Preset', 'Please disconnect first before switching presets');
            this.presetSelect.value = '';
            this.deleteBtn.disabled = true;
            return;
        }

        try {
            const response = await fetch('http://localhost:5000/api/presets/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: selectedPreset })
            });

            const data = await response.json();

            if (data.success) {
                // Fill in the credentials
                this.apiIdInput.value = data.data.api_id;
                this.apiHashInput.value = data.data.api_hash;
                this.phoneInput.value = data.data.phone_number;

                window.app.showToast('success', 'Preset Loaded', `Loaded credentials for "${selectedPreset}"`);
            } else {
                window.app.showToast('error', 'Load Failed', data.error);
            }
        } catch (error) {
            console.error('Failed to load preset:', error);
            window.app.showToast('error', 'Load Failed', 'Could not load preset');
        }
    }

    async savePreset() {
        // Check if connected -prevent saving while connected
        if (this.isConnected()) {
            window.app.showToast('error', 'Cannot Save', 'Please disconnect first before saving a preset');
            return;
        }

        // Get current credentials
        const apiId = this.apiIdInput.value.trim();
        const apiHash = this.apiHashInput.value.trim();
        const phoneNumber = this.phoneInput.value.trim();

        if (!apiId || !apiHash || !phoneNumber) {
            window.app.showToast('error', 'Missing Credentials', 'Please fill in all fields before saving');
            return;
        }

        // Show the preset name modal instead of using prompt()
        this.showPresetNameModal((presetName) => {
            if (!presetName || !presetName.trim()) {
                return; // User cancelled or entered empty name
            }

            // Save the preset
            this.savePresetWithName(presetName.trim(), apiId, apiHash, phoneNumber);
        });
    }

    showPresetNameModal(callback) {
        const modal = document.getElementById('preset-name-modal');
        const input = document.getElementById('preset-name-input');
        const submitBtn = document.getElementById('submit-preset-name');
        const cancelBtn = document.getElementById('cancel-preset-name');

        // Clear previous input
        input.value = '';

        // Show modal
        window.app.showModal('preset-name-modal');

        // Focus on input
        setTimeout(() => input.focus(), 100);

        // Handle submit
        const handleSubmit = () => {
            const value = input.value;
            cleanup();
            callback(value);
            window.app.hideModal();
        };

        // Handle cancel
        const handleCancel = () => {
            cleanup();
            callback(null);
            window.app.hideModal();
        };

        // Handle Enter key
        const handleKeyPress = (e) => {
            if (e.key === 'Enter') {
                handleSubmit();
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        };

        // Cleanup function to remove event listeners
        const cleanup = () => {
            submitBtn.removeEventListener('click', handleSubmit);
            cancelBtn.removeEventListener('click', handleCancel);
            input.removeEventListener('keypress', handleKeyPress);
        };

        // Add event listeners
        submitBtn.addEventListener('click', handleSubmit);
        cancelBtn.addEventListener('click', handleCancel);
        input.addEventListener('keypress', handleKeyPress);
    }

    async savePresetWithName(presetName, apiId, apiHash, phoneNumber) {
        try {
            const response = await fetch('http://localhost:5000/api/presets/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: presetName.trim(),
                    api_id: apiId,
                    api_hash: apiHash,
                    phone_number: phoneNumber
                })
            });

            const data = await response.json();

            if (data.success) {
                window.app.showToast('success', 'Preset Saved', `Saved as "${presetName.trim()}"`);
                await this.loadPresets(); // Reload the dropdown
            } else {
                window.app.showToast('error', 'Save Failed', data.error);
            }
        } catch (error) {
            console.error('Failed to save preset:', error);
            window.app.showToast('error', 'Save Failed', 'Could not save preset');
        }
    }

    async deletePreset() {
        const selectedPreset = this.presetSelect.value;

        if (!selectedPreset) {
            return;
        }

        // Check if connected
        if (this.isConnected()) {
            window.app.showToast('error', 'Cannot Delete', 'Please disconnect first before deleting a preset');
            return;
        }

        // Confirm deletion
        if (!confirm(`Are you sure you want to delete the preset "${selectedPreset}"?`)) {
            return;
        }

        try {
            const response = await fetch('http://localhost:5000/api/presets/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: selectedPreset })
            });

            const data = await response.json();

            if (data.success) {
                window.app.showToast('success', 'Preset Deleted', `Deleted "${selectedPreset}"`);

                // Clear the fields
                this.apiIdInput.value = '';
                this.apiHashInput.value = '';
                this.phoneInput.value = '';

                // Reload presets
                await this.loadPresets();
                this.deleteBtn.disabled = true;
            } else {
                window.app.showToast('error', 'Delete Failed', data.error);
            }
        } catch (error) {
            console.error('Failed to delete preset:', error);
            window.app.showToast('error', 'Delete Failed', 'Could not delete preset');
        }
    }

    isConnected() {
        // Check if Telegram is connected by looking at the status indicator
        const statusElement = document.getElementById('telegram-connection-status');
        if (!statusElement) return false;

        const statusIcon = statusElement.querySelector('i');
        return statusIcon && statusIcon.classList.contains('text-success');
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.telegramPresetManager = new TelegramPresetManager();
});
