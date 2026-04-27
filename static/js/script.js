document.addEventListener('DOMContentLoaded', () => {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const hljsThemeDark = document.getElementById('hljs-theme-dark');
    const hljsThemeLight = document.getElementById('hljs-theme-light');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const chatMessages = document.getElementById('chat-messages');
    const modelSelect = document.getElementById('model-select');
    const conversationList = document.getElementById('conversation-list');
    const newChatBtn = document.getElementById('new-chat-btn');
    const currentTitle = document.getElementById('current-title');
    const statusIndicator = document.getElementById('status-indicator');
    const ttsToggle = document.getElementById('tts-toggle');
    const toolsToggle = document.getElementById('tools-toggle');
    const canvasToggle = document.getElementById('canvas-toggle');
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const voiceBtn = document.getElementById('voice-btn');
    const previewArea = document.getElementById('preview-area');

    // Canvas elements
    const canvasPanel = document.getElementById('canvas-panel');
    const canvasTitle = document.getElementById('canvas-title');
    const canvasLang = document.getElementById('canvas-lang');
    const canvasCopyBtn = document.getElementById('canvas-copy-btn');
    const canvasDownloadBtn = document.getElementById('canvas-download-btn');
    const canvasCloseBtn = document.getElementById('canvas-close-btn');

    let currentConversationId = null;
    let messages = [];
    let isGenerating = false;
    let abortController = null;
    let attachedFiles = []; // { name, content, type, url }
    let canvasEditor = null; // CodeMirror instance
    let generatedTitle = null; // Holds auto-generated title

    // Configure Marked
    marked.setOptions({
        highlight: function (code, lang) {
            if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(code, { language: lang }).value;
            }
            return hljs.highlightAuto(code).value;
        },
        breaks: true
    });

    function renderMarkdownToHtml(markdownText) {
        const raw = marked.parse(markdownText || '');
        if (window.DOMPurify) {
            return window.DOMPurify.sanitize(raw);
        }
        return raw;
    }

    // Theme handling (system default with manual override)
    const THEME_STORAGE_KEY = 'theme'; // 'light' | 'dark'

    function safeStorageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function safeStorageSet(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            return false;
        }
    }

    function setHljsTheme(theme) {
        if (!hljsThemeDark || !hljsThemeLight) return;
        if (theme === 'light') {
            hljsThemeLight.disabled = false;
            hljsThemeDark.disabled = true;
        } else {
            hljsThemeLight.disabled = true;
            hljsThemeDark.disabled = false;
        }
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        setHljsTheme(theme);

        if (canvasEditor) {
            canvasEditor.setOption('theme', theme === 'light' ? 'default' : 'material-darker');
            canvasEditor.refresh();
        }
    }

    function getSystemTheme() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    function getEffectiveTheme() {
        const stored = safeStorageGet(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
        return getSystemTheme();
    }

    function toggleThemeManual() {
        const current = getEffectiveTheme();
        const next = current === 'dark' ? 'light' : 'dark';
        safeStorageSet(THEME_STORAGE_KEY, next);
        applyTheme(next);
    }

    // Apply initial theme ASAP
    applyTheme(getEffectiveTheme());

    if (themeToggleBtn) {
        themeToggleBtn.style.cursor = 'pointer';
        themeToggleBtn.addEventListener('click', toggleThemeManual);
    }

    // If user hasn't manually overridden, keep in sync with system changes
    if (window.matchMedia) {
        const mql = window.matchMedia('(prefers-color-scheme: light)');
        const onSystemThemeChange = () => {
            const stored = safeStorageGet(THEME_STORAGE_KEY);
            if (stored !== 'light' && stored !== 'dark') {
                applyTheme(getSystemTheme());
            }
        };
        if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', onSystemThemeChange);
        } else if (typeof mql.addListener === 'function') {
            mql.addListener(onSystemThemeChange);
        }
    }

    // Initialize CodeMirror
    function initCanvas() {
        if (canvasEditor) return;
        canvasEditor = CodeMirror.fromTextArea(document.getElementById('canvas-editor'), {
            theme: getEffectiveTheme() === 'light' ? 'default' : 'material-darker',
            lineNumbers: true,
            lineWrapping: true,
            readOnly: false,
            mode: 'javascript',
            tabSize: 4,
            indentWithTabs: false,
        });
    }

    // Canvas mode map
    const LANG_MODE_MAP = {
        'python': 'python',
        'py': 'python',
        'javascript': 'javascript',
        'js': 'javascript',
        'typescript': 'javascript',
        'ts': 'javascript',
        'html': 'htmlmixed',
        'css': 'css',
        'json': 'javascript',
        'c': 'text/x-csrc',
        'cpp': 'text/x-c++src',
        'c++': 'text/x-c++src',
        'java': 'text/x-java',
        'rust': 'rust',
        'go': 'go',
        'sql': 'sql',
        'shell': 'shell',
        'bash': 'shell',
        'sh': 'shell',
        'markdown': 'markdown',
        'md': 'markdown',
        'xml': 'xml',
    };

    function openCanvas(lang) {
        initCanvas();
        canvasPanel.classList.add('open');
        const mode = LANG_MODE_MAP[lang] || 'javascript';
        canvasEditor.setOption('mode', mode);
        canvasLang.textContent = lang || 'code';
        canvasEditor.setValue('');
        canvasEditor.refresh();
    }

    function closeCanvas() {
        canvasPanel.classList.remove('open');
        canvasToggle.checked = false;
    }

    canvasCloseBtn.onclick = closeCanvas;

    canvasCopyBtn.onclick = () => {
        if (!canvasEditor) return;
        navigator.clipboard.writeText(canvasEditor.getValue()).then(() => {
            canvasCopyBtn.textContent = '✓';
            setTimeout(() => { canvasCopyBtn.textContent = '📋'; }, 1500);
        });
    };

    canvasDownloadBtn.onclick = () => {
        if (!canvasEditor) return;
        const content = canvasEditor.getValue();
        const lang = canvasLang.textContent || 'txt';
        const ext = { python: 'py', javascript: 'js', html: 'html', css: 'css', rust: 'rs', go: 'go', shell: 'sh', sql: 'sql', markdown: 'md' }[lang] || 'txt';
        const blob = new Blob([content], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `canvas.${ext}`;
        a.click();
        URL.revokeObjectURL(a.href);
    };

    // Canvas toggle — manual open/close
    canvasToggle.addEventListener('change', () => {
        if (canvasToggle.checked) {
            openCanvas('');
        } else {
            closeCanvas();
        }
    });

    // Auto-resize textarea
    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = (chatInput.scrollHeight) + 'px';
    });

    // Load available models
    async function loadModels() {
        try {
            const response = await fetch('/api/models');
            const data = await response.json();
            if (data.models) {
                modelSelect.innerHTML = '<option value="" disabled>Select Model</option>';
                data.models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model.name;
                    option.textContent = model.name;
                    modelSelect.appendChild(option);
                });
                if (data.models.length > 0) modelSelect.selectedIndex = 1;
            }
        } catch (error) {
            console.error('Error loading models:', error);
            appendMessage('model', 'SYSTEM', 'Error loading models. Is Ollama running?');
        }
    }

    // Load conversations
    async function loadConversations() {
        try {
            const response = await fetch('/api/conversations');
            const data = await response.json();
            conversationList.innerHTML = '';
            data.forEach(conv => {
                const item = document.createElement('div');
                item.className = `conversation-item ${conv.id === currentConversationId ? 'active' : ''}`;

                const titleSpan = document.createElement('span');
                titleSpan.textContent = conv.title;
                titleSpan.onclick = () => loadConversation(conv.id);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'icon-btn delete-conv-btn';
                deleteBtn.innerHTML = '×';
                deleteBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (deleteBtn.classList.contains('confirming')) {
                        console.log('Confirmed delete for:', conv.id);
                        deleteConversation(conv.id);
                    } else {
                        deleteBtn.classList.add('confirming');
                        deleteBtn.innerHTML = '✓'; // Change to checkmark for confirm
                        setTimeout(() => {
                            deleteBtn.classList.remove('confirming');
                            deleteBtn.innerHTML = '×';
                        }, 3000); // 3 seconds to confirm
                    }
                };

                item.appendChild(titleSpan);
                item.appendChild(deleteBtn);
                conversationList.appendChild(item);
            });
        } catch (error) {
            console.error('Error loading conversations:', error);
        }
    }

    async function deleteConversation(id) {
        try {
            const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
            const result = await response.json();
            console.log('Delete result:', result);
            if (currentConversationId === id) {
                newChat();
            } else {
                loadConversations();
            }
        } catch (error) {
            console.error('Error deleting conversation:', error);
        }
    }

    // Load a specific conversation
    async function loadConversation(id) {
        console.log('Loading conversation:', id);
        try {
            const response = await fetch(`/api/conversations/${id}`);
            const data = await response.json();
            currentConversationId = id;
            messages = data.messages;
            currentTitle.textContent = data.title;

            chatMessages.innerHTML = `
                <div class="terminal-start">OLLAMA WORKBENCH v3.0.2</div>
                <div class="terminal-info">Session re-established: ${data.title}</div>
                <div class="terminal-ready">${getFeaturesReadyMessage()}</div>
            `;

            messages.forEach(msg => {
                appendMessage(msg.role === 'user' ? 'user' : 'model',
                    msg.role === 'user' ? USERNAME : 'MODEL',
                    msg.content);
            });

            loadConversations();
        } catch (error) {
            console.error('Error loading conversation:', error);
        }
    }

    // Append a message to the UI
    function appendMessage(type, prefixName, content) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${type}`;

        const prefix = document.createElement('span');
        prefix.className = 'prefix';
        prefix.textContent = prefixName;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'content';

        if (type === 'model') {
            contentDiv.innerHTML = renderMarkdownToHtml(content);
        } else {
            contentDiv.textContent = content;
        }

        msgDiv.appendChild(prefix);
        msgDiv.appendChild(contentDiv);
        chatMessages.appendChild(msgDiv);

        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Apply syntax highlighting to new code blocks
        contentDiv.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
        });

        return contentDiv;
    }

    // Create or get the thinking block for the current response
    function getOrCreateThinkingBlock(msgDiv) {
        let block = msgDiv.querySelector('.thinking-block');
        if (!block) {
            block = document.createElement('details');
            block.className = 'thinking-block';
            block.setAttribute('open', '');
            block.innerHTML = `
                <summary><span class="chevron">▶</span> <span class="thinking-spinner"></span> Thinking...</summary>
                <div class="thinking-content"></div>
            `;
            // Insert before the content div
            const contentDiv = msgDiv.querySelector('.content');
            msgDiv.insertBefore(block, contentDiv);
        }
        return block;
    }

    function finalizeThinkingBlock(msgDiv) {
        const block = msgDiv.querySelector('.thinking-block');
        if (block) {
            block.removeAttribute('open');
            const summary = block.querySelector('summary');
            const spinner = summary.querySelector('.thinking-spinner');
            if (spinner) spinner.remove();
            const thinkContent = block.querySelector('.thinking-content');
            const lineCount = (thinkContent.textContent.match(/\n/g) || []).length + 1;
            summary.innerHTML = `<span class="chevron">▶</span> Thought for ${lineCount} steps`;
        }
    }

    function getFeaturesReadyMessage() {
        const features = [];
        if (toolsToggle.checked) features.push('Tools');
        if (canvasToggle.checked) features.push('Canvas');
        if (ttsToggle.checked) features.push('TTS');

        if (features.length === 0) {
            return 'Inference ready, standing by.';
        }

        let msg = 'Thinking Tokens';
        if (features.length === 1) {
            msg += ` & ${features[0]}`;
        } else {
            const last = features.pop();
            msg += ', ' + features.join(', ') + ` & ${last}`;
        }
        return `${msg} Ready.`;
    }

    function updateTerminalReadyMessage() {
        const readyLines = document.querySelectorAll('.terminal-ready');
        if (readyLines.length > 0) {
            readyLines[readyLines.length - 1].textContent = getFeaturesReadyMessage();
        }
    }

    [ttsToggle, toolsToggle, canvasToggle].forEach(toggle => {
        toggle.addEventListener('change', updateTerminalReadyMessage);
    });

    // Send message handler
    async function sendMessage() {
        const text = chatInput.value.trim();
        const model = modelSelect.value;
        console.log('Sending message to model:', model, 'Text:', text);

        if ((!text && attachedFiles.length === 0) || !model || isGenerating) {
            console.warn('Send blocked:', { text, attachedFiles: attachedFiles.length, model, isGenerating });
            return;
        }

        isGenerating = true;
        statusIndicator.classList.add('active');
        sendBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');

        chatInput.value = '';
        chatInput.style.height = 'auto';

        // Prepare context from attached files
        let fullPrompt = text;
        let images = [];

        attachedFiles.forEach(file => {
            if (file.type === 'text') {
                fullPrompt += `\n\n[Content of ${file.name}]:\n${file.content}`;
            } else if (file.type === 'image') {
                images.push(file.content.split(',')[1]); // Base64 part only
            }
        });

        // Add user message to state and UI
        messages.push({ role: 'user', content: fullPrompt });
        if (images.length > 0) messages[messages.length - 1].images = images;

        appendMessage('user', USERNAME, text || `Uploaded ${attachedFiles.length} files`);

        // Clear preview
        attachedFiles = [];
        previewArea.innerHTML = '';
        previewArea.classList.add('hidden');

        // Create model response bubble
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message model';
        const prefix = document.createElement('span');
        prefix.className = 'prefix';
        prefix.textContent = 'MODEL';
        const messageContentElement = document.createElement('div');
        messageContentElement.className = 'content';
        messageContentElement.innerHTML = renderMarkdownToHtml('*Thinking, this may take a moment...*');
        msgDiv.appendChild(prefix);
        msgDiv.appendChild(messageContentElement);
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        let modelResponse = '';
        let thinkingContent = '';
        let isInCanvas = false;
        let canvasBuffer = '';
        let canvasLangDetected = '';
        let hasStartedContent = false;

        const toolsEnabled = toolsToggle.checked;
        const canvasEnabled = canvasToggle.checked;

        abortController = new AbortController();
        console.log('Fetching /api/chat with payload:', { model, messages, tools_enabled: toolsEnabled, canvas_enabled: canvasEnabled });

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages,
                    tools_enabled: toolsEnabled,
                    canvas_enabled: canvasEnabled
                }),
                signal: abortController.signal
            });

            console.log('Response status:', response.status);
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Unknown error');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let lineBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                lineBuffer += decoder.decode(value, { stream: true });
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop(); // Buffer partial line

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);

                        // Handle typed events from our backend
                        if (data.type === 'thinking') {
                            thinkingContent += data.content;
                            const block = getOrCreateThinkingBlock(msgDiv);
                            const thinkDiv = block.querySelector('.thinking-content');
                            thinkDiv.textContent = thinkingContent;
                            chatMessages.scrollTop = chatMessages.scrollHeight;
                            continue;
                        }

                        if (data.type === 'tool_status' && data.message && data.message.content) {
                            modelResponse += data.message.content;
                            messageContentElement.innerHTML = renderMarkdownToHtml(modelResponse);
                            chatMessages.scrollTop = chatMessages.scrollHeight;
                            continue;
                        }

                        // Handle content (typed or legacy format)
                        let contentChunk = null;
                        if (data.type === 'content' && data.message && data.message.content) {
                            contentChunk = data.message.content;
                        } else if (!data.type && data.message && data.message.content) {
                            // Legacy format from tool re-trigger path
                            contentChunk = data.message.content;
                        }

                        if (contentChunk) {
                            // Finalize thinking block when content starts
                            if (!hasStartedContent && thinkingContent) {
                                finalizeThinkingBlock(msgDiv);
                                hasStartedContent = true;
                            }
                            if (!hasStartedContent) {
                                hasStartedContent = true;
                            }

                            // Canvas detection
                            const fullText = modelResponse + contentChunk;

                            // Check for canvas_mode opening tag
                            if (!isInCanvas && fullText.includes('<canvas_mode')) {
                                const match = fullText.match(/<canvas_mode(?:\s+lang=['"]?(\w+)['"]?)?>/);
                                if (match) {
                                    isInCanvas = true;
                                    canvasLangDetected = match[1] || '';
                                    openCanvas(canvasLangDetected);
                                    // Split: text before the tag goes to chat, text after goes to canvas
                                    const tagEnd = fullText.indexOf('>', fullText.indexOf('<canvas_mode')) + 1;
                                    const beforeTag = fullText.substring(0, fullText.indexOf('<canvas_mode'));
                                    const afterTag = fullText.substring(tagEnd);
                                    modelResponse = beforeTag;
                                    messageContentElement.innerHTML = renderMarkdownToHtml(modelResponse);
                                    canvasBuffer = afterTag;
                                    if (canvasEditor) {
                                        canvasEditor.setValue(canvasBuffer);
                                    }
                                    chatMessages.scrollTop = chatMessages.scrollHeight;
                                    continue;
                                }
                            }

                            if (isInCanvas) {
                                // Check for closing tag
                                canvasBuffer += contentChunk;
                                if (canvasBuffer.includes('</canvas_mode>')) {
                                    isInCanvas = false;
                                    const parts = canvasBuffer.split('</canvas_mode>');
                                    const actualCode = parts[0];
                                    const afterTag = parts.slice(1).join('</canvas_mode>');

                                    canvasBuffer = actualCode;
                                    if (canvasEditor) {
                                        canvasEditor.setValue(canvasBuffer);
                                    }
                                    // Add a note in the chat and resume modelResponse with anything after the tag
                                    modelResponse += '\n\n*📝 Code written to Canvas →*\n' + afterTag;
                                    messageContentElement.innerHTML = renderMarkdownToHtml(modelResponse);
                                } else {
                                    // Prevent partial closing tag (e.g. "</can") from leaking into canvas during stream
                                    let previewBuffer = canvasBuffer;
                                    const partialMatch = canvasBuffer.match(/<\/c[anvas_mode]*$/);
                                    if (partialMatch) {
                                        previewBuffer = canvasBuffer.substring(0, partialMatch.index);
                                    }
                                    if (canvasEditor) {
                                        canvasEditor.setValue(previewBuffer);
                                    }
                                }
                                chatMessages.scrollTop = chatMessages.scrollHeight;
                                continue;
                            }

                            // Normal content — append to chat bubble
                            modelResponse += contentChunk;
                            messageContentElement.innerHTML = renderMarkdownToHtml(modelResponse);
                            chatMessages.scrollTop = chatMessages.scrollHeight;

                            // Re-apply code highlighting for partial updates
                            messageContentElement.querySelectorAll('pre code').forEach((block) => {
                                hljs.highlightElement(block);
                            });
                        }

                        if (data.error) {
                            appendMessage('model', 'SYSTEM', `Error: ${data.error}`);
                        }
                    } catch (e) {
                        console.warn('JSON parse error on line:', line, e);
                    }
                }
            }

            // Handle any remaining content in buffer
            if (lineBuffer.trim()) {
                try {
                    const data = JSON.parse(lineBuffer);
                    const contentChunk = (data.type === 'content' && data.message && data.message.content)
                        ? data.message.content
                        : (!data.type && data.message && data.message.content)
                            ? data.message.content
                            : null;
                    if (contentChunk) {
                        modelResponse += contentChunk;
                        messageContentElement.innerHTML = renderMarkdownToHtml(modelResponse);
                    }
                } catch (e) { /* ignore partial trailing data */ }
            }

            // Finalize any open thinking block
            if (thinkingContent && !hasStartedContent) {
                finalizeThinkingBlock(msgDiv);
            }

            if (modelResponse) {
                messages.push({ role: 'assistant', content: modelResponse });
                console.log('Conversation complete, saving...');

                // Auto-generate title on first exchange
                if (messages.length === 2 && !generatedTitle) {
                    generateAutoTitle(messages[0].content, model);
                }

                saveConversation();
            }

            // TTS Playback if enabled
            if (ttsToggle.checked && modelResponse) {
                playTTS(modelResponse);
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                messageContentElement.innerHTML += '<br><em>[Generation Stopped]</em>';
            } else {
                console.error('Chat error:', error);
                messageContentElement.textContent += '\n[CONNECTION ERROR]';
            }
        } finally {
            isGenerating = false;
            statusIndicator.classList.remove('active');
            sendBtn.classList.remove('hidden');
            stopBtn.classList.add('hidden');
            abortController = null;
        }
    }

    // Auto-title generation
    async function generateAutoTitle(firstMessage, model) {
        try {
            const response = await fetch('/api/generate-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: firstMessage, model })
            });
            const data = await response.json();
            if (data.title && data.title !== 'New Chat') {
                generatedTitle = data.title;
                currentTitle.textContent = generatedTitle;
                // Re-save with the generated title
                saveConversation();
                loadConversations();
            }
        } catch (error) {
            console.error('Auto-title error:', error);
        }
    }

    async function playTTS(text) {
        try {
            // Clean markdown for TTS
            const cleanText = text.replace(/[*#`_\[\]()]/g, '');
            const response = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cleanText })
            });
            const data = await response.json();
            if (data.url) {
                const audio = new Audio(data.url);
                audio.play();
            }
        } catch (error) {
            console.error('TTS error:', error);
        }
    }

    // File Upload Handling
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    addFileToPreview(file.name, ev.target.result, 'image');
                };
                reader.readAsDataURL(file);
            } else {
                // Upload to backend for extraction
                const formData = new FormData();
                formData.append('file', file);
                try {
                    const response = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData
                    });
                    let data = null;
                    try {
                        data = await response.json();
                    } catch (e) {
                        data = null;
                    }

                    if (!response.ok) {
                        const detail = data && (data.detail || data.error) ? (data.detail || data.error) : `Upload failed (HTTP ${response.status})`;
                        appendMessage('model', 'SYSTEM', `Upload error for ${file.name}: ${detail}`);
                        continue;
                    }

                    if (data && data.status === 'success') {
                        addFileToPreview(file.name, data.content, 'text');
                    } else {
                        appendMessage('model', 'SYSTEM', `Upload error for ${file.name}: Unexpected server response`);
                    }
                } catch (error) {
                    console.error('Upload error:', error);
                    appendMessage('model', 'SYSTEM', `Upload error for ${file.name}: ${error.message || 'Unknown error'}`);
                }
            }
        }
        fileInput.value = '';
    };

    function addFileToPreview(name, content, type) {
        previewArea.classList.remove('hidden');
        attachedFiles.push({ name, content, type });

        const div = document.createElement('div');
        div.className = 'preview-item';

        if (type === 'image') {
            const img = document.createElement('img');
            img.src = content;
            div.appendChild(img);
        } else {
            div.textContent = name.substring(0, 5) + '..';
            div.title = name;
        }

        const removeBtn = document.createElement('div');
        removeBtn.className = 'preview-remove';
        removeBtn.innerHTML = '×';
        removeBtn.onclick = () => {
            attachedFiles = attachedFiles.filter(f => f.name !== name);
            div.remove();
            if (attachedFiles.length === 0) previewArea.classList.add('hidden');
        };

        div.appendChild(removeBtn);
        previewArea.appendChild(div);
    }

    // Voice Input (Web Speech API)
    let recognition = null;
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => {
            voiceBtn.style.color = '#ff5f56';
            statusIndicator.classList.add('active');
        };

        recognition.onresult = (event) => {
            const result = event.results[0][0].transcript;
            chatInput.value += result;
            chatInput.dispatchEvent(new Event('input'));
        };

        recognition.onend = () => {
            voiceBtn.style.color = '';
            statusIndicator.classList.remove('active');
        };
    }

    voiceBtn.onclick = () => {
        if (recognition) {
            recognition.start();
        } else {
            alert('Speech recognition not supported in this browser.');
        }
    };

    // Save conversation to backend
    async function saveConversation() {
        if (messages.length === 0) return;

        // Use generated title if available, otherwise fall back to truncated first message
        let title = generatedTitle;
        if (!title) {
            const firstUserMsgObj = messages.find(m => m.role === 'user');
            const firstUserContent = firstUserMsgObj ? (firstUserMsgObj.content || 'Untitled') : 'Untitled';
            title = firstUserContent.substring(0, 30) + (firstUserContent.length > 30 ? '...' : '');
        }

        const data = {
            id: currentConversationId,
            title: title,
            timestamp: new Date().toISOString(),
            messages: messages
        };

        console.log('POSTing conversation to /api/conversations:', data);

        try {
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await response.json();
            console.log('Save result:', result);
            if (result.id && !currentConversationId) {
                currentConversationId = result.id;
                loadConversations();
            }
        } catch (error) {
            console.error('Error saving conversation:', error);
        }
    }

    function newChat() {
        currentConversationId = null;
        messages = [];
        generatedTitle = null;
        chatMessages.innerHTML = `
            <div class="terminal-start">OLLAMA WORKBENCH v3.0.2</div>
            <div class="terminal-info">New session started.</div>
            <div class="terminal-ready">${getFeaturesReadyMessage()}</div>
        `;
        currentTitle.textContent = 'New Conversation';
        loadConversations();
        // Close canvas on new chat
        closeCanvas();
        canvasToggle.checked = false;
    }

    // Event Listeners
    sendBtn.onclick = sendMessage;
    stopBtn.onclick = () => { if (abortController) abortController.abort(); };
    chatInput.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    newChatBtn.onclick = newChat;

    // Emoji Logic (re-using part from previous version)
    const emojiBtn = document.getElementById('emoji-btn');
    const emojiPanel = document.getElementById('emoji-panel');
    const emojiList = document.getElementById('emoji-list');
    const emojiTabs = document.querySelectorAll('.emoji-tab');

    const EMOJI_GROUPS = {
        smileys: ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖'],
        symbols: ['∑', '∏', '∫', '∆', '∇', '√', '∞', '≈', '≠', '≤', '≥', '±', '÷', '×', '∂', 'µ', 'π', 'Ω', 'β', 'α', 'γ', 'δ', 'ε', 'λ', 'θ', 'φ', '¢', '£', '€', '¥', '§', '¶', '©', '®', '™', '°', '†', '‡', '•', '←', '↑', '→', '↓', '↔', '↖', '↗', '↘', '↙', '♠', '♣', '♥', '♦', '✓', '✗', '★', '☆', '☎', '⌨', '✉', '✈', '⚙', '⚖', '⌘', '⌥', '⌃', '⇧', ''],
        accented: ['á', 'é', 'í', 'ó', 'ú', 'ý', 'à', 'è', 'ì', 'ò', 'ù', 'â', 'ê', 'î', 'ô', 'û', 'ä', 'ë', 'ï', 'ö', 'ü', 'ÿ', 'ã', 'ñ', 'õ', 'ç', 'å', 'ø', 'æ', 'œ', 'ß', 'ð', 'þ', 'Á', 'É', 'Í', 'Ó', 'Ú', 'Ý', 'À', 'È', 'Ì', 'Ò', 'Ù', 'Â', 'Ê', 'Î', 'Ô', 'Û', 'Ä', 'Ë', 'Ï', 'Ö', 'Ü', 'Ÿ', 'Ã', 'Ñ', 'Õ', 'Ç', 'Å', 'Ø', 'Æ', 'Œ']
    };

    function renderEmojiGroup(group) {
        emojiList.innerHTML = '';
        EMOJI_GROUPS[group].forEach(emoji => {
            const btn = document.createElement('button');
            btn.className = 'emoji-item';
            btn.textContent = emoji;
            btn.onclick = () => {
                const start = chatInput.selectionStart;
                const end = chatInput.selectionEnd;
                chatInput.value = chatInput.value.substring(0, start) + emoji + chatInput.value.substring(end);
                chatInput.focus();
                chatInput.dispatchEvent(new Event('input'));
            };
            emojiList.appendChild(btn);
        });
    }

    emojiBtn.onclick = (e) => {
        e.stopPropagation();
        emojiPanel.classList.toggle('hidden');
        if (!emojiPanel.classList.contains('hidden')) renderEmojiGroup('smileys');
    };

    emojiTabs.forEach(tab => {
        tab.onclick = (e) => {
            e.stopPropagation();
            emojiTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderEmojiGroup(tab.dataset.group);
        };
    });

    document.addEventListener('click', (e) => {
        if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) {
            emojiPanel.classList.add('hidden');
        }
    });

    // Initial load
    loadModels();
    loadConversations();
    updateTerminalReadyMessage();
});
