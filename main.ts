import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	EditorPosition,
	Setting
} from 'obsidian';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

interface MyPluginSettings {
	mySetting: string;
	r2Config: {
		bucketName: string;
		accessKeyId: string;
		secretAccessKey: string;
		endpoint: string;
		region: string;
		publicUrl: string;
		directory: string;
	};
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	r2Config: {
		bucketName: '',
		accessKeyId: '',
		secretAccessKey: '',
		endpoint: '',
		region: 'auto',
		publicUrl: '',
		directory: ''
	}
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Handle drag and drop events at the DOM level
		this.setupDragDropHandlers();
	}

	private setupDragDropHandlers() {
		const handleDragOver = (evt: DragEvent) => {
			if (evt.dataTransfer?.files.length) {
				// Only preventDefault if there are image files
				const hasImageFiles = Array.from(evt.dataTransfer.files).some(file => 
					file.type.startsWith('image/')
				);
				if (hasImageFiles) {
					evt.preventDefault();
					evt.stopPropagation();
				}
			}
		};

		const handleDrop = async (evt: DragEvent) => {
			if (!evt.dataTransfer?.files.length) return;

			// Filter for image files
			const imageFiles = Array.from(evt.dataTransfer.files).filter(file => 
				file.type.startsWith('image/')
			);

			if (imageFiles.length === 0) return;

			// Completely prevent Obsidian's default handling
			evt.preventDefault();
			evt.stopPropagation();
			evt.stopImmediatePropagation();

			// Get the active Markdown view and editor
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) {
				new Notice('No active Markdown file found.');
				return;
			}

			const editor = activeView.editor;
			const cursor = editor.getCursor();

			// Prepare file data
			const fileData = imageFiles.map(file => ({
				name: file.name,
				type: file.type,
				file: file
			}));

			// Main processing
			await this.handleDrop(fileData, editor, evt, cursor);
		};

		// Set up event listeners when the workspace is ready
		this.app.workspace.onLayoutReady(() => {
			// Add event listeners directly to the editor container
			const workspaceEl = this.app.workspace.containerEl;
			
			workspaceEl.addEventListener('dragover', handleDragOver, true);
			workspaceEl.addEventListener('drop', handleDrop, true);

			// Remove event listeners when the plugin is unloaded
			this.register(() => {
				workspaceEl.removeEventListener('dragover', handleDragOver, true);
				workspaceEl.removeEventListener('drop', handleDrop, true);
			});
		});
	}

	private async handleDrop(fileData: { name: string; type: string; file: File }[], editor: Editor, evt: DragEvent, cursor: EditorPosition) {
		// Step 1: Retrive Image Files
		const files = fileData.map(data => data.file)
		if (files.length === 0) return;

		// Step 2: Check for Active File
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file detected.');
			return;
		}

		// Step 3: Process files sequentially to maintain cursor position
		let currentCursor = { ...cursor };
		
		for (const file of files) {
			try {
				// Throw an error if R2 configuration is incomplete
				if (!this.settings.r2Config.bucketName || !this.settings.r2Config.accessKeyId || 
					!this.settings.r2Config.secretAccessKey || !this.settings.r2Config.endpoint) {
					throw new Error('R2 configuration is incomplete. Please check the plugin settings.');
				}

				// Create S3Client (for Cloudflare R2)
				const s3Client = new S3Client({
					region: this.settings.r2Config.region,
					endpoint: this.settings.r2Config.endpoint,
					credentials: {
						accessKeyId: this.settings.r2Config.accessKeyId,
						secretAccessKey: this.settings.r2Config.secretAccessKey,
					},
				});

				// Generate a file name (add a timestamp to avoid duplicates)
				const timestamp = new Date().getTime();
				const fileExtension = file.name.split('.').pop();
				const baseFileName = `${timestamp}_${file.name}`;
				
				// Include the directory if specified
				const fileName = this.settings.r2Config.directory 
					? `${this.settings.r2Config.directory.replace(/^\/+|\/+$/g, '')}/${baseFileName}`
					: baseFileName;

				// Convert the file to an ArrayBuffer
				const fileBuffer = await file.arrayBuffer();

				// Upload the file to R2
				const uploadCommand = new PutObjectCommand({
					Bucket: this.settings.r2Config.bucketName,
					Key: fileName,
					Body: new Uint8Array(fileBuffer),
					ContentType: file.type,
				});

				const _response = await s3Client.send(uploadCommand);

				// Generate the URL for the uploaded file
				const baseUrl = this.settings.r2Config.publicUrl.endsWith('/') 
					? this.settings.r2Config.publicUrl.slice(0, -1) 
					: this.settings.r2Config.publicUrl;
				const fileUrl = `${baseUrl}/${fileName}`;

				// Generate the Markdown link
				let markdownLink = '';
				if (file.type.startsWith('image/')) {
					markdownLink = `![${file.name}](${fileUrl})`;
				} else {
					markdownLink = `[${file.name}](${fileUrl})`;
				}

				// Insert into the editor
				editor.replaceRange(markdownLink, currentCursor);

				// Update cursor position (for the next file)
				const insertedLines = markdownLink.split('\n').length - 1;
				const lastLineLength = markdownLink.split('\n').pop()?.length || 0;
				
				if (insertedLines > 0) {
					currentCursor.line += insertedLines;
					currentCursor.ch = lastLineLength;
				} else {
					currentCursor.ch += lastLineLength;
				}

				// Add a newline (for multiple files)
				if (files.length > 1 && file !== files[files.length - 1]) {
					editor.replaceRange('\n', currentCursor);
					currentCursor.line++;
					currentCursor.ch = 0;
				}

				new Notice(`File "${file.name}" has been uploaded.`);

			} catch (error) {
				console.error('Error during file upload:', error);
				new Notice(`Failed to upload file "${file.name}": ${error.message}`);
			}
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// R2 Settings Section
		containerEl.createEl('h2', {text: 'Cloudflare R2 Settings'});

		new Setting(containerEl)
			.setName('Bucket Name')
			.setDesc('Enter your Cloudflare R2 bucket name')
			.addText(text => text
				.setPlaceholder('your-bucket-name')
				.setValue(this.plugin.settings.r2Config.bucketName)
				.onChange(async (value) => {
					this.plugin.settings.r2Config.bucketName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Access Key ID')
			.setDesc('Enter your Cloudflare R2 Access Key ID')
			.addText(text => text
				.setPlaceholder('your-access-key-id')
				.setValue(this.plugin.settings.r2Config.accessKeyId)
				.onChange(async (value) => {
					this.plugin.settings.r2Config.accessKeyId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Secret Access Key')
			.setDesc('Enter your Cloudflare R2 Secret Access Key')
			.addText(text => text
				.setPlaceholder('your-secret-access-key')
				.setValue(this.plugin.settings.r2Config.secretAccessKey)
				.onChange(async (value) => {
					this.plugin.settings.r2Config.secretAccessKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Endpoint')
			.setDesc('Enter your Cloudflare R2 endpoint URL')
			.addText(text => text
				.setPlaceholder('https://your-account-id.r2.cloudflarestorage.com')
				.setValue(this.plugin.settings.r2Config.endpoint)
				.onChange(async (value) => {
					this.plugin.settings.r2Config.endpoint = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Region')
			.setDesc('Specify the region for your Cloudflare R2 bucket (usually "auto" is fine)')
			.addText(text => text
				.setPlaceholder('auto')
				.setValue(this.plugin.settings.r2Config.region)
				.onChange(async (value) => {
					this.plugin.settings.r2Config.region = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Public URL')
			.setDesc('Enter the public URL to access your uploaded files')
			.addText(text => text
				.setPlaceholder('https://your-custom-domain.com')
				.setValue(this.plugin.settings.r2Config.publicUrl)
				.onChange(async (value) => {
					this.plugin.settings.r2Config.publicUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Directory (Optional)')
			.setDesc('Specify a directory to upload files into (e.g., images, attachments). If empty, files will be saved in the root.')
			.addText(text => text
				.setPlaceholder('images')
				.setValue(this.plugin.settings.r2Config.directory)
				.onChange(async (value) => {
					this.plugin.settings.r2Config.directory = value;
					await this.plugin.saveSettings();
				}));
	}
}
