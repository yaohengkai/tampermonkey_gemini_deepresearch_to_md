// ==UserScript==
// @name         Gemini Deep Research Exporter
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Deep Research 导出最终极速版：
// @author       Eddy
// @match        https://gemini.google.com/*
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    GM_registerMenuCommand("⚡️ 导出 Markdown", executeExport);

    let globalCitations = [];

    const UI_BLACKLIST = ["Export to Sheets", "Export to Gmail", "Show drafts", "Regenerate", "Modify response", "share", "more_vert", "volume_up", "thumb_up", "thumb_down", "google_lens", "Sources", "View other drafts", "expand_more"];

    async function executeExport() {
        globalCitations = [];

        showToast('⚡️ 正在扫描引用 (多源模式)...', 0);

        try {
            const contentNodes = getResponseNodes();
            if (!contentNodes.length) throw new Error("页面未就绪");

            // --- 阶段 1: 抓取引用 ---
            for (const node of contentNodes) {
                await processCitationsInNode(node);
            }

            // --- 阶段 1.5: 抓取思考过程 ---
            let thoughtsMarkdown = "";
            if (contentNodes.length > 0) {
                thoughtsMarkdown = await processThoughts(contentNodes[contentNodes.length - 1], globalCitations.length);
            }

            // --- 阶段 2: 文本解析 ---
            showToast('📝 正在解析文本内容...', 0);

            let fullMarkdown = "";
            contentNodes.forEach((node) => {
                fullMarkdown += parseNode(node, { listDepth: -1, inTable: false });
                fullMarkdown += "\n\n---\n\n";
            });

            // --- 阶段 3: 清洗与组合 ---
            fullMarkdown = cleanMarkdown(fullMarkdown);

            // 添加正文参考文献
            if (globalCitations.length > 0) {
                fullMarkdown += "\n\n## 🔗 正文参考文献 (References)\n\n";
                globalCitations.sort((a,b) => a.id - b.id).forEach(cite => {
                    fullMarkdown += `[^${cite.id}]: [${cite.title}](${cite.url})\n\n`;
                });
            }

            // 添加思考过程
            if (thoughtsMarkdown) {
                fullMarkdown += thoughtsMarkdown;
            }

            downloadMD(fullMarkdown);
            showToast(`✅ 导出成功！引用源: ${globalCitations.length} | 思考过程已处理`, 4000);

        } catch (e) {
            console.error(e);
            showToast(`❌ 错误: ${e.message}`, 5000);
        }
    }

    // --- 思考过程处理 ---
    async function processThoughts(anchorNode, startCitationIndex) {
        try {
            const container = anchorNode.closest('[data-test-id="scroll-container"]') || document.body;
            const btn = container.querySelector('.collapsible-thinking-button') ||
                        Array.from(container.querySelectorAll('div, button')).find(el => el.innerText === "Thoughts" && el.classList.contains('gds-title-m'))?.parentElement;

            if (!btn) return "";

            showToast('🧠 正在提取并格式化思考过程...', 0);

            let isExpanded = btn.getAttribute('aria-expanded') === 'true';
            if (!isExpanded) {
                btn.click();
                await new Promise(r => setTimeout(r, 1200));
            }

            const panel = container.querySelector('.thinking-panel');
            if (!panel) return "";

            let mdContent = "\n\n---\n\n## 🧠 思考过程 (Thoughts)\n\n";
            let thoughtRefs = [];
            let currentRefId = startCitationIndex;

            let steps = Array.from(panel.children);
            steps = steps.filter(s => s.innerText.trim().length > 0 && !s.classList.contains('mat-progress-spinner'));

            steps.forEach((step, index) => {
                let clone = step.cloneNode(true);

                removeTextFromNode(clone, "Researching websites");
                removeTextFromNode(clone, "Analysis");

                // 提取链接
                const links = clone.querySelectorAll('a');
                let stepRefIds = [];

                links.forEach(link => {
                    const url = link.href;
                    if (!url || url.startsWith('javascript')) return;

                    currentRefId++;
                    const title = link.innerText.trim() || "Source";

                    thoughtRefs.push({ id: currentRefId, title: title, url: url });
                    stepRefIds.push(currentRefId);
                    link.remove(); // 移除链接节点，防止它留在正文中
                });

                // 提取标题
                let titleText = "";
                const titleNode = clone.querySelector('strong, b, h3, .title');
                if (titleNode) {
                    titleText = titleNode.innerText.trim();
                    titleNode.remove();
                } else {
                    const fullText = clone.innerText;
                    const splitIdx = fullText.indexOf('\n');
                    if (splitIdx > 0 && splitIdx < 50) {
                        titleText = fullText.substring(0, splitIdx).trim();
                        removeTextFromNode(clone, titleText);
                    }
                }

                // 解析内容
                let bodyMarkdown = parseNode(clone, { listDepth: 0, inTable: false }).trim();
                titleText = titleText.replace(/:$/, '').trim();

                // --- 修改点：仅加粗 Step 和标题，内容不加粗 ---
                let stepHeader = "";
                if (titleText) {
                    stepHeader = `Step ${index + 1} ${titleText}:`;
                } else {
                    stepHeader = `Step ${index + 1}:`;
                }

                // 组合：**标题** 内容
                mdContent += `**${stepHeader}** ${bodyMarkdown}`;

                // --- 修改点：角标紧跟内容，不换行 ---
                if (stepRefIds.length > 0) {
                    const refString = stepRefIds.map(id => `[^${id}]`).join('');
                    mdContent += ` ${refString}\n\n`;
                } else {
                    mdContent += `\n\n`;
                }
            });

            // 思考过程的参考文献
            if (thoughtRefs.length > 0) {
                mdContent += "\n**思考过程参考文献**\n\n";
                thoughtRefs.forEach(ref => {
                    mdContent += `[^${ref.id}]: [${ref.title}](${ref.url})\n\n`;
                });
            }

            if (!isExpanded) {
                setTimeout(() => { try { btn.click(); } catch(e) {} }, 200);
            }

            return mdContent;

        } catch (err) {
            console.warn("思考过程提取失败", err);
            return "";
        }
    }

    // --- 辅助工具 ---
    function removeTextFromNode(element, textToRemove) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while(node = walker.nextNode()) {
            if (node.nodeValue.includes(textToRemove)) {
                node.nodeValue = node.nodeValue.replace(textToRemove, "");
            }
        }
    }

    async function processCitationsInNode(rootNode) {
        const container = rootNode.closest('[data-test-id="scroll-container"]') || rootNode;
        const buttons = Array.from(container.querySelectorAll('button[aria-label="Learn More"]:not([data-citation-scanned="true"])'));

        if (buttons.length === 0) return;

        showToast(`🔍 发现 ${buttons.length} 个引用组，正在极速处理...`, 0);

        for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            try {
                btn.click();
                const foundLinks = await waitForLinksToAppear(btn);
                let assignedIds = [];

                if (foundLinks && foundLinks.length > 0) {
                    for (const link of foundLinks) {
                        const url = link.href;
                        const title = link.innerText.trim() || link.textContent.trim() || url;
                        const existingCite = globalCitations.find(c => c.url === url);
                        let finalId = -1;

                        if (existingCite) {
                            finalId = existingCite.id;
                        } else {
                            finalId = globalCitations.length + 1;
                            globalCitations.push({ id: finalId, title: title, url: url });
                        }
                        assignedIds.push(finalId);
                    }
                } else {
                    const finalId = globalCitations.length + 1;
                    globalCitations.push({ id: finalId, title: "Unknown Source", url: "#" });
                    assignedIds.push(finalId);
                }

                btn.setAttribute('data-citation-scanned', 'true');
                btn.setAttribute('data-citation-id', assignedIds.join(','));
                setTimeout(() => { try { btn.click(); } catch(e) {} }, 50);

            } catch (err) { console.warn("引用处理异常", err); }
            await new Promise(r => setTimeout(r, 80));
        }
    }

    function waitForLinksToAppear(btn) {
        return new Promise((resolve) => {
            let links = findLinksNearButton(btn);
            if (links.length > 0) return resolve(links);
            const startTime = Date.now();
            const intervalId = setInterval(() => {
                links = findLinksNearButton(btn);
                if (links.length > 0) { clearInterval(intervalId); resolve(links); }
                if (Date.now() - startTime > 2500) { clearInterval(intervalId); resolve([]); }
            }, 50);
        });
    }

    function findLinksNearButton(btn) {
        if (btn.tagName === 'A' && btn.href) return [btn];
        let parent = btn.parentElement;
        for (let k = 0; k < 4; k++) {
            if (!parent) break;
            const candidates = Array.from(parent.querySelectorAll('a[href]'));
            const validLinks = [];
            const seenUrls = new Set();
            for (let link of candidates) {
                if (link.href && !link.href.startsWith('javascript') && !link.href.startsWith('#') && link !== btn && link.offsetParent !== null) {
                    if (!seenUrls.has(link.href)) {
                        seenUrls.add(link.href);
                        validLinks.push(link);
                    }
                }
            }
            if (validLinks.length > 0) return validLinks;
            parent = parent.parentElement;
        }
        return [];
    }

    // --- Markdown 解析 ---
    function parseNode(node, context) {
        if (!node) return '';

        if (node.nodeType === Node.TEXT_NODE) {
            let text = node.textContent.replace(/\s+/g, ' ');
            if (context.inTable) return text.replace(/\|/g, '\\|').trim();
            return text;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            if (shouldSkipNode(node)) return '';

            if (node.hasAttribute && node.hasAttribute('data-citation-id')) {
                const idAttr = node.getAttribute('data-citation-id');
                const ids = idAttr.split(',');
                return ids.map(id => `[^${id}]`).join('');
            }

            const tag = node.tagName.toLowerCase();
            const classList = (node.getAttribute('class') || "");

            // LaTeX 处理
            const isMath = classList.includes('katex') || classList.includes('math-block') || tag === 'math' || tag === 'math-renderer' || node.hasAttribute('data-tex') || node.hasAttribute('data-math') || classList.includes('math-display');

            if (isMath) {
                let latex = extractLatex(node);
                if (latex) return latex;
                if (classList.includes('katex-html')) return '';
                const label = node.getAttribute('aria-label');
                if (label) return `$${label}$`;
                return node.innerText.trim();
            }

            if (tag === 'table') return parseTable(node);
            if (tag === 'pre') {
                const codeDiv = node.querySelector('div[data-language]');
                const lang = codeDiv ? codeDiv.getAttribute('data-language') : '';
                const codeContent = node.querySelector('code')?.innerText || node.innerText;
                const cleanCode = codeContent.replace(/Copy code|content_copy/g, '').trim();
                return `\n\`\`\`${lang}\n${cleanCode}\n\`\`\`\n`;
            }

            if (tag === 'ul' || tag === 'ol') {
                let inner = '';
                for (const child of node.childNodes) inner += parseNode(child, { ...context, listDepth: context.listDepth + 1 });
                return `\n${inner}\n`;
            }
            if (tag === 'li') {
                const indent = '  '.repeat(Math.max(0, context.listDepth));
                return `\n${indent}- ${parseChildren(node, context).trim()}`;
            }

            if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(parseInt(tag[1]))} ${parseChildren(node, context).trim()}\n\n`;
            if (tag === 'strong' || tag === 'b') return `**${parseChildren(node, context)}**`;
            if (tag === 'em' || tag === 'i') return `*${parseChildren(node, context)}*`;

            if (tag === 'a') {
                const inner = parseChildren(node, context);
                const href = node.getAttribute('href');
                if (/^\[\d+\]$/.test(inner.trim()) || /^\[\^\d+\]$/.test(inner.trim())) return inner;
                if (href && !href.startsWith('javascript')) return `[${inner}](${href})`;
                return inner;
            }

            let result = parseChildren(node, context);
            if ((tag === 'p' || tag === 'div') && result.trim().length > 0) return `\n${result}\n`;

            return result;
        }
        return '';
    }

    function parseChildren(node, context) {
        let inner = '';
        for (const child of node.childNodes) inner += parseNode(child, context);
        return inner;
    }

    function extractLatex(node) {
        let tex = null;
        let isDisplay = false;
        if (node.classList.contains('katex-display') || node.classList.contains('math-block') || node.getAttribute('display') === 'block' || node.tagName === 'DIV' || node.querySelector('.katex-display')) isDisplay = true;

        if (node.hasAttribute('data-math')) tex = node.getAttribute('data-math');
        else { const dm = node.querySelector('[data-math]'); if (dm) tex = dm.getAttribute('data-math'); }

        if (!tex) {
            const annotations = node.querySelectorAll('annotation');
            for (let ann of annotations) if (ann.getAttribute('encoding') === 'application/x-tex') { tex = ann.textContent; break; }
        }

        if (!tex && node.hasAttribute('data-tex')) tex = node.getAttribute('data-tex');
        if (!tex) { const dt = node.querySelector('[data-tex]'); if (dt) tex = dt.getAttribute('data-tex'); }

        if (tex) {
            tex = tex.trim().replace(/^LaTeX:\s*/i, '').replace(/^\$+|\$+$/g, '');
            if (tex.startsWith('<') && tex.includes('>')) return null;
            if (tex.endsWith('\\')) tex += ' ';
            if (tex.length > 50 || tex.includes('\\sum') || tex.includes('\\int') || tex.includes('\\frac')) isDisplay = true;
            return isDisplay ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
        }
        return null;
    }

    function shouldSkipNode(node) {
        const label = (node.getAttribute('aria-label') || "") + (node.className || "");
        if (UI_BLACKLIST.some(b => label.includes(b) || node.innerText === b)) return true;
        return false;
    }

    function parseTable(tableNode) {
        const rows = Array.from(tableNode.querySelectorAll('tr'));
        if (!rows.length) return '';
        let md = '\n';
        const matrix = rows.map(r => Array.from(r.querySelectorAll('td, th')).map(c => {
            return parseChildren(c, { listDepth: -1, inTable: true }).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
        }));
        if (matrix.length) {
            const headers = matrix[0];
            md += `| ${headers.join(' | ')} |\n| ${headers.map(()=>'---').join(' | ')} |\n`;
            for(let i=1; i<matrix.length; i++) if(matrix[i].length === headers.length) md += `| ${matrix[i].join(' | ')} |\n`;
        }
        return md + '\n';
    }

    function getResponseNodes() {
        const allResponses = document.querySelectorAll('model-response-text, message-content');
        if (allResponses.length === 0) return [];
        return [allResponses[allResponses.length - 1]];
    }

    function cleanMarkdown(text) {
        return text
            .replace(/[ \t]+/g, ' ')
            .replace(/ \./g, '.')
            .replace(/ ,/g, ',')
            .replace(/ \[\^/g, '[^')
            .replace(/\]\[\^/g, '][^')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function downloadMD(content) {
        const titleLine = content.split('\n')[0].replace(/[#*]/g, '').trim().substring(0, 30) || "Gemini_Export";
        const fileName = `${titleLine}_${new Date().toISOString().slice(0,10)}.md`;
        const blob = new Blob([content], {type: 'text/markdown'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
    }

    let toastTimeout;
    function showToast(text, duration = 3000) {
        let toast = document.getElementById('gemini-export-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'gemini-export-toast';
            toast.style.cssText = `position: fixed; top: 20px; right: 20px; z-index: 100000; background: #333; color: #fff; padding: 12px 24px; border-radius: 8px; font-family: sans-serif; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: opacity 0.3s; pointer-events: none; opacity: 0;`;
            document.body.appendChild(toast);
        }
        toast.innerText = text;
        toast.style.opacity = '1';
        if (toastTimeout) clearTimeout(toastTimeout);
        if (duration > 0) toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, duration);
    }

})();