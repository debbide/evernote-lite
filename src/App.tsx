import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import Editor from '@monaco-editor/react';
import { Search, Plus, Trash2, FileText, Pin, Copy, Check, X, Tag, Eye, Edit2, Minus, Square, Settings, Download } from 'lucide-react';
import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
import { register, isRegistered } from '@tauri-apps/plugin-global-shortcut';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import './App.css';

interface Note {
  id: number;
  title: string;
  snippet: string;
  content: string;
  is_pinned: number;
  tags: string;
  language: string;
  updated_at: number;
}

// 自动检测环境：如果有 Tauri 环境就用真实的，否则用前端内存模拟（为了极速测试 UI）
const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;

let mockNotes: Note[] = [];
let mockIdCounter = 1;

const invoke = async <T,>(cmd: string, args?: any): Promise<T> => {
  if (isTauri) {
    return tauriInvoke(cmd, args) as Promise<T>;
  }
  // 以下是纯前端模拟数据，确保每次返回全新引用，避免 React 状态更新被吃掉
  await new Promise(r => setTimeout(r, 50)); 
  
  if (cmd === 'get_notes') {
    const q = args?.query || '';
    let res = [...mockNotes];
    if (q) {
      res = res.filter(n => n.title.includes(q) || n.content.includes(q) || n.tags.includes(q));
    }
    // 排序：先按置顶，再按更新时间
    return res.sort((a,b) => b.is_pinned - a.is_pinned || b.updated_at - a.updated_at) as unknown as T;
  }
  
  if (cmd === 'save_note') {
    if (args?.id !== null && args?.id !== undefined) {
      const idx = mockNotes.findIndex(n => n.id === args.id);
      if (idx !== -1) {
        mockNotes[idx] = { 
          ...mockNotes[idx], 
          title: args.title, 
          content: args.content, 
          snippet: args.content.substring(0, 50).replace(/\n/g, ' '),
          is_pinned: args.is_pinned ?? mockNotes[idx].is_pinned,
          tags: args.tags ?? mockNotes[idx].tags,
          language: args.language ?? mockNotes[idx].language,
          updated_at: Date.now() / 1000 
        };
      }
      return args.id as unknown as T;
    } else {
      const newId = mockIdCounter++;
      mockNotes.push({
        id: newId,
        title: args.title,
        content: args.content,
        snippet: '',
        is_pinned: args.is_pinned ?? 0,
        tags: args.tags ?? '[]',
        language: args.language ?? 'markdown',
        updated_at: Date.now() / 1000
      });
      return newId as unknown as T;
    }
  }
  
  if (cmd === 'delete_note') {
    mockNotes = mockNotes.filter(n => n.id !== args?.id);
    return undefined as unknown as T;
  }
  
  throw new Error(`Command ${cmd} not mocked`);
};

// 提取的子组件，用于渲染带右上角复制按钮的代码块
function CodeBlock({ code, lang }: { code: string, lang: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative group bg-[#141414] rounded-md border border-[#2A2A2A] my-4 overflow-hidden">
      <div className="absolute top-2 right-2 flex items-center gap-2">
        {lang && <span className="text-[10px] text-gray-500 font-mono uppercase">{lang}</span>}
        <button 
          onClick={handleCopy}
          className="p-1.5 rounded-md bg-[#2A2A2A] text-gray-400 hover:text-white hover:bg-[#3A3A3A] transition-colors opacity-0 group-hover:opacity-100"
        >
          {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="p-4 overflow-x-hidden whitespace-pre-wrap break-all text-sm text-gray-300 font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function HighlightText({ text, keyword }: { text: string; keyword: string }) {
  if (!keyword.trim()) return <>{text}</>;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === keyword.toLowerCase()
          ? <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded-sm px-0.5">{part}</mark>
          : part
      )}
    </>
  );
}

function getMatchSnippet(content: string, keyword: string, maxLen: number = 60): string | null {
  if (!keyword.trim()) return null;
  const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - 20);
  const end = Math.min(content.length, idx + keyword.length + maxLen - 20);
  let snippet = content.substring(start, end).replace(/\n/g, ' ');
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  return snippet;
}

function TitleBar({ onHide }: { onHide: () => void }) {
  if (!isTauri) return null;
  const appWindow = getCurrentWindow();
  return (
    <div 
      onMouseDown={(e) => {
        if (e.buttons === 1) { // Only left click
          appWindow.startDragging();
        }
      }}
      className="h-8 bg-[#181818] border-b border-[#2B2B2B] flex items-center justify-between select-none"
    >
      <div className="text-xs text-gray-500 font-bold tracking-widest pl-4 pointer-events-none uppercase">evernote-lite</div>
      <div className="flex h-full" onMouseDown={(e) => e.stopPropagation()}>
        <button onClick={() => appWindow.minimize()} className="h-full px-4 text-gray-400 hover:text-white hover:bg-[#2B2B2B] transition-colors flex items-center justify-center">
          <Minus size={14} />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} className="h-full px-4 text-gray-400 hover:text-white hover:bg-[#2B2B2B] transition-colors flex items-center justify-center">
          <Square size={12} />
        </button>
        <button onClick={onHide} className="h-full px-4 text-gray-400 hover:text-white hover:bg-red-500 transition-colors flex items-center justify-center">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const [showSettings, setShowSettingsState] = useState(false);
  const setShowSettings = (val: boolean) => { showSettingsRef.current = val; setShowSettingsState(val); };
  const [autoStart, setAutoStart] = useState(false);
  const [s3Config, setS3Config] = useState({ endpoint: '', bucket: '', region: '', access_key: '', secret_key: '', retention: 30 });
  interface BackupInfo {
    key: string;
    name: string;
    size: number;
    last_modified: string;
    trigger: string;
  }
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const fetchBackups = async () => {
    setBackupsLoading(true);
    try {
      const list = await invoke<BackupInfo[]>('list_backups', {});
      setBackups(list);
    } catch (e: any) {
      setS3Status('读取备份历史失败: ' + (e.message || String(e)));
    } finally {
      setBackupsLoading(false);
    }
  };
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };
  const formatBackupTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    } catch { return iso; }
  };
  const [s3Status, setS3Status] = useState<string | null>(null);
  const [s3Loading, setS3Loading] = useState(false);
  const [previewModes, setPreviewModes] = useState<Record<number, boolean>>(() => {
    const saved = localStorage.getItem('evernote_lite_preview_modes');
    try { return saved ? JSON.parse(saved) : {}; } catch { return {}; }
  });
  
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  // Debounce saving
  const [typingTimeout, setTypingTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ id: number; title: string; content: string; is_pinned: number; tags: string; language: string } | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSettingsRef = useRef(false);

  const flushSave = async () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (pending) {
      pendingSaveRef.current = null;
      try {
        await invoke('save_note', { id: pending.id, title: pending.title, content: pending.content, isPinned: pending.is_pinned, tags: pending.tags, language: pending.language });
      } catch (error) {
        console.error('Failed to flush save:', error);
      }
    }
  };

  const fetchNotes = useCallback(async (query: string = '') => {
    try {
      const fetchedNotes = await invoke<Note[]>('get_notes', { query });
      setNotes(fetchedNotes);
    } catch (error: any) {
      console.error('Failed to fetch notes:', error);
      alert('加载失败: ' + (error.message || String(error)));
    }
  }, []);

  // 获取启动参数（是否是通过双击外部文件打开）
  useEffect(() => {
    if (!isTauri) return;
    
    const importFile = async (filename: string, content: string) => {
      let lang = 'markdown';
      if (filename.endsWith('.json')) lang = 'json';
      else if (filename.endsWith('.js') || filename.endsWith('.ts')) lang = 'typescript';
      else if (filename.endsWith('.py')) lang = 'python';
      else if (filename.endsWith('.rs')) lang = 'rust';
      else if (filename.endsWith('.html')) lang = 'html';
      else if (filename.endsWith('.css')) lang = 'css';
      else if (filename.endsWith('.sql')) lang = 'sql';
      
      try {
        const newId = await invoke<number>('save_note', { 
          id: null, 
          title: filename, 
          content: content,
          isPinned: 0,
          tags: '["导入"]',
          language: lang
        });
        const fetchedNotes = await invoke<Note[]>('get_notes', { query: '' });
        setNotes(fetchedNotes);
        const newNote = fetchedNotes.find(n => n.id === newId);
        if (newNote) {
          setSelectedNote(newNote);
          setPreviewModes(prev => {
            const next = { ...prev, [newNote.id]: false };
            localStorage.setItem('evernote_lite_preview_modes', JSON.stringify(next));
            return next;
          });
        }
      } catch (err) {
        console.error('Failed to import file:', err);
      }
    };

    // 1. 检查初次启动参数
    invoke<[string, string] | null>('get_launch_file').then(async (fileData) => {
      if (fileData) {
        importFile(fileData[0], fileData[1]);
      }
    }).catch(console.error);

    // 2. 监听单实例后续传递的参数
    const unlisten = listen<[string, string]>('import-external-file', (event) => {
      const [filename, content] = event.payload;
      importFile(filename, content);
    });
    
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  // 每天自动备份一次
  useEffect(() => {
    if (!isTauri) return;
    const tryAutoBackup = async () => {
      try {
        const path = await invoke<any>('get_s3_config', {});
        if (!path.endpoint || !path.bucket || !path.access_key || !path.secret_key) return;
        const lastBackup = localStorage.getItem('evernote_lite_last_backup');
        const now = Date.now();
        if (lastBackup && now - parseInt(lastBackup) < 24 * 60 * 60 * 1000) return;
        await invoke('backup_to_s3', { trigger: 'auto' });
        localStorage.setItem('evernote_lite_last_backup', String(now));
        console.log('Auto backup succeeded');
      } catch (e) {
        console.error('Auto backup failed:', e);
      }
    };
    tryAutoBackup();
  }, []);

  useEffect(() => {
    fetchNotes(searchQuery);
    
    // Init Tauri plugins
    if (isTauri) {
      try {
        isEnabled().then(setAutoStart).catch(console.error);
        isRegistered('Ctrl+Shift+Space').then(registered => {
          if (!registered) {
            register('Ctrl+Shift+Space', async (event: any) => {
              if (event.state === 'Released') return; // 防止按下和抬起触发两次导致闪烁
              
              const win = getCurrentWindow();
              const visible = await win.isVisible();
              const focused = await win.isFocused();
              if (visible && focused) {
                await flushSave();
                await win.hide();
              } else {
                await win.show();
                await win.unminimize();
                await win.setAlwaysOnTop(true);
                await win.setFocus();
                await win.setAlwaysOnTop(false);
              }
            }).catch(console.error);
          }
        });
      } catch (e) { console.error(e); }
    }
    
    // ESC 隐藏窗口
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTauri) {
        if (showSettingsRef.current) {
          setShowSettings(false);
        } else {
          await flushSave();
          await getCurrentWindow().hide();
        }
      }
      if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey)) {
        const inEditor = document.activeElement?.closest('.monaco-editor');
        if (!inEditor) e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery, fetchNotes]);

  const handleCreateNote = async () => {
    try {
      const newId = await invoke<number>('save_note', { 
        id: null, 
        title: '无标题笔记', 
        content: '',
        isPinned: 0,
        tags: '[]',
        language: 'markdown'
      });
      const fetchedNotes = await invoke<Note[]>('get_notes', { query: searchQuery });
      setNotes(fetchedNotes);
      const newNote = fetchedNotes.find(n => n.id === newId);
      if (newNote) {
        setSelectedNote(newNote);
        setPreviewModes(prev => {
          const next = { ...prev, [newNote.id]: false };
          localStorage.setItem('evernote_lite_preview_modes', JSON.stringify(next));
          return next;
        }); // 新建时默认进入编辑模式
      }
    } catch (error: any) {
      console.error('Failed to create note:', error);
      alert('保存失败: ' + (error.message || String(error)));
    }
  };

  const handleDeleteNote = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('确定要删除这条笔记吗？')) return;
    try {
      await invoke('delete_note', { id });
      if (selectedNote?.id === id) {
        setSelectedNote(null);
      }
      fetchNotes(searchQuery);
    } catch (error) {
      console.error('Failed to delete note:', error);
    }
  };

  const handleTogglePin = async (note: Note, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const newPinState = note.is_pinned ? 0 : 1;
      await invoke('save_note', { 
        id: note.id,
        title: note.title,
        content: note.content,
        isPinned: newPinState,
        tags: note.tags || '[]',
        language: note.language || 'markdown'
      });
      if (selectedNote?.id === note.id) {
        setSelectedNote({ ...selectedNote, is_pinned: newPinState });
      }
      fetchNotes(searchQuery);
    } catch (error) {
      console.error('Failed to toggle pin:', error);
    }
  };

  const saveNoteDebounced = (id: number, title: string, content: string, is_pinned: number, tags: string, language: string) => {
    if (typingTimeout) clearTimeout(typingTimeout);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    pendingSaveRef.current = { id, title, content, is_pinned, tags, language };

    const timeout = setTimeout(async () => {
      pendingSaveRef.current = null;
      typingTimeoutRef.current = null;
      try {
        await invoke('save_note', { id, title, content, isPinned: is_pinned, tags, language });
        fetchNotes(searchQuery);
      } catch (error) {
        console.error('Failed to auto-save note:', error);
      }
    }, 1000);
    setTypingTimeout(timeout);
    typingTimeoutRef.current = timeout;
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedNote) return;
    const newTitle = e.target.value;
    setSelectedNote({ ...selectedNote, title: newTitle });
    saveNoteDebounced(selectedNote.id, newTitle, selectedNote.content, selectedNote.is_pinned, selectedNote.tags, selectedNote.language);
  };

  const handleContentChange = (value: string | undefined) => {
    if (!selectedNote || value === undefined) return;
    setSelectedNote({ ...selectedNote, content: value });
    saveNoteDebounced(selectedNote.id, selectedNote.title, value, selectedNote.is_pinned, selectedNote.tags, selectedNote.language);
  };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!selectedNote) return;
    const newLang = e.target.value;
    setSelectedNote({ ...selectedNote, language: newLang });
    saveNoteDebounced(selectedNote.id, selectedNote.title, selectedNote.content, selectedNote.is_pinned, selectedNote.tags, newLang);
  };

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // 添加右键菜单：包裹为代码块
    if (!editor.getAction('wrap-in-code-block')) {
      editor.addAction({
        id: 'wrap-in-code-block',
        label: '转化为代码块 (Wrap in Code Block)',
        contextMenuGroupId: 'modification',
        contextMenuOrder: 1.5,
        run: function (ed: any) {
          const selection = ed.getSelection();
          const model = ed.getModel();
          if (!selection || !model) return;
          const selectedText = model.getValueInRange(selection);
          if (!selectedText) return;
          const wrapped = '```\n' + selectedText + '\n```';
          ed.executeEdits('wrap-code-block', [{
            range: selection,
            text: wrapped,
            forceMoveMarkers: true
          }]);
        }
      });
    }

    // 动态 UI 美化 (Decorations)
    const decorationsCollection = editor.createDecorationsCollection([]);
    const updateDecorations = () => {
      const model = editor.getModel();
      if (!model) return;
      const text = model.getValue();
      const lines = text.split('\n');
      const newDecorations: any[] = [];
      let inBlock = false;
      let blockStart = 0;
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('```')) {
          if (!inBlock) {
            inBlock = true;
            blockStart = i + 1;
            newDecorations.push({
              range: new monaco.Range(i + 1, 1, i + 1, lines[i].length + 1),
              options: { inlineClassName: 'code-block-boundary-text' }
            });
          } else {
            inBlock = false;
            newDecorations.push({
              range: new monaco.Range(i + 1, 1, i + 1, lines[i].length + 1),
              options: { inlineClassName: 'code-block-boundary-text' }
            });
            if (i > blockStart) { // 有实质内容
              newDecorations.push({
                range: new monaco.Range(blockStart + 1, 1, i, 1),
                options: {
                  isWholeLine: true,
                  className: 'code-block-bg'
                }
              });
            }
          }
        }
      }
      decorationsCollection.set(newDecorations);
    };

    editor.onDidChangeModelContent(() => updateDecorations());
    setTimeout(updateDecorations, 100);

    // 只注册一次 CodeLens
    if (!(window as any)._codeLensRegistered) {
      // 注册全局命令用于复制
      const copyCmd = editor.addCommand(0, (_ctx: any, textToCopy: string) => {
        navigator.clipboard.writeText(textToCopy);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      });

      monaco.languages.registerCodeLensProvider('markdown', {
        provideCodeLenses: function (model: any, _token: any) {
          const text = model.getValue();
          const lenses: any[] = [];
          const lines = text.split('\n');
          
          let inBlock = false;
          let blockStart = 0;
          let blockContent: string[] = [];
          
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('```')) {
              if (!inBlock) {
                inBlock = true;
                blockStart = i + 1;
                blockContent = [];
              } else {
                inBlock = false;
                const contentToCopy = blockContent.join('\n');
                lenses.push({
                  range: new monaco.Range(blockStart, 1, blockStart, 1),
                  id: "CopySnippet" + blockStart,
                  command: {
                    id: copyCmd,
                    title: "📋 复制片段",
                    arguments: [contentToCopy]
                  }
                });
              }
            } else if (inBlock) {
              blockContent.push(lines[i]);
            }
          }
          return { lenses, dispose: () => {} };
        },
        resolveCodeLens: function (_model: any, codeLens: any, _token: any) {
          return codeLens;
        }
      });
      (window as any)._codeLensRegistered = true;
    }
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && tagInput.trim() && selectedNote) {
      const currentTags = JSON.parse(selectedNote.tags || '[]');
      const newTag = tagInput.trim();
      if (!currentTags.includes(newTag)) {
        const newTags = JSON.stringify([...currentTags, newTag]);
        setSelectedNote({ ...selectedNote, tags: newTags });
        saveNoteDebounced(selectedNote.id, selectedNote.title, selectedNote.content, selectedNote.is_pinned, newTags, selectedNote.language);
      }
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    if (!selectedNote) return;
    const currentTags = JSON.parse(selectedNote.tags || '[]');
    const newTags = JSON.stringify(currentTags.filter((t: string) => t !== tagToRemove));
    setSelectedNote({ ...selectedNote, tags: newTags });
    saveNoteDebounced(selectedNote.id, selectedNote.title, selectedNote.content, selectedNote.is_pinned, newTags, selectedNote.language);
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  };

  const handleCopy = () => {
    if (!selectedNote) return;
    navigator.clipboard.writeText(selectedNote.content);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleExport = async () => {
    if (!selectedNote) return;
    try {
      // 根据语言自动推断扩展名
      let ext = 'md';
      let filterName = 'Markdown';
      
      switch (selectedNote.language) {
        case 'python': ext = 'py'; filterName = 'Python Script'; break;
        case 'javascript': ext = 'js'; filterName = 'JavaScript'; break;
        case 'typescript': ext = 'ts'; filterName = 'TypeScript'; break;
        case 'json': ext = 'json'; filterName = 'JSON Document'; break;
        case 'rust': ext = 'rs'; filterName = 'Rust Source'; break;
        case 'html': ext = 'html'; filterName = 'HTML Document'; break;
        case 'css': ext = 'css'; filterName = 'CSS Stylesheet'; break;
        case 'sql': ext = 'sql'; filterName = 'SQL Script'; break;
      }

      const filePath = await save({
        filters: [
          { name: filterName, extensions: [ext] },
          { name: 'All Files', extensions: ['*'] }
        ],
        defaultPath: `${selectedNote.title || 'snippet'}.${ext}`,
      });

      if (filePath) {
        await writeTextFile(filePath, selectedNote.content);
        // 可选：添加一点成功反馈
      }
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  // 提取所有唯一标签
  const allTags = Array.from(new Set(notes.flatMap(n => JSON.parse(n.tags || '[]'))));
  
  // 过滤笔记
  const displayedNotes = selectedTagFilter 
    ? notes.filter(n => JSON.parse(n.tags || '[]').includes(selectedTagFilter))
    : notes;

  return (
    <div className="flex flex-col h-screen bg-[#1E1E1E] overflow-hidden text-gray-200">
      <TitleBar onHide={async () => { await flushSave(); await getCurrentWindow().hide(); }} />
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-72 bg-[#181818] border-r border-[#2B2B2B] flex flex-col shrink-0">
        <div className="p-4 border-b border-[#2B2B2B] flex flex-col gap-3">
          <div className="flex justify-between items-center px-6 py-4 border-b border-[#2B2B2B] bg-[#1E1E1E]">
            <h1 className="text-lg font-semibold tracking-wide">备忘录</h1>
            <button onClick={handleCreateNote} className="p-1.5 hover:bg-[#2A2A2A] rounded-md transition-colors text-gray-400 hover:text-white">
              <Plus size={18} />
            </button>
          </div>
          
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input 
              type="text" 
              placeholder="搜索所有内容..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#252526] border border-[#3E3E42] rounded-md py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:border-[#555] transition-colors placeholder:text-gray-500"
            />
          </div>
          
          {/* Tags filter row */}
          {allTags.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
              <button 
                onClick={() => setSelectedTagFilter(null)}
                className={`shrink-0 px-2 py-1 text-xs rounded-full transition-colors ${!selectedTagFilter ? 'bg-[#3A3D41] text-white' : 'bg-[#252526] text-gray-400 hover:bg-[#2D2D30]'}`}
              >
                全部
              </button>
              {allTags.map((tag: any) => (
                <button 
                  key={tag}
                  onClick={() => setSelectedTagFilter(tag)}
                  className={`shrink-0 px-2 py-1 text-xs rounded-full transition-colors flex items-center gap-1 ${selectedTagFilter === tag ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30' : 'bg-[#252526] text-gray-400 hover:bg-[#2D2D30] border border-transparent'}`}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {displayedNotes.length === 0 ? (
            <div className="text-center text-gray-600 text-sm mt-10">没有找到笔记</div>
          ) : (
            displayedNotes.map(note => {
              const tags = JSON.parse(note.tags || '[]');
              const contentSnippet = searchQuery ? getMatchSnippet(note.content, searchQuery) : null;
              return (
                <div 
                  key={note.id} 
                  onClick={() => setSelectedNote(note)}
                  className={`group p-4 border-b border-[#2B2B2B] cursor-pointer transition-colors relative ${selectedNote?.id === note.id ? 'bg-[#2D2D30]' : 'hover:bg-[#252526]'}`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-center gap-2 pr-12 overflow-hidden">
                      {note.is_pinned === 1 && <Pin size={12} className="text-blue-400 shrink-0 fill-blue-400/20" />}
                      <h3 className="font-medium text-sm truncate text-gray-200"><HighlightText text={note.title} keyword={searchQuery} /></h3>
                    </div>
                    <div className="absolute right-3 top-3.5 opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                      <button 
                        onClick={(e) => handleTogglePin(note, e)}
                        className={`p-1 rounded-sm transition-colors ${note.is_pinned ? 'text-blue-400 hover:text-blue-300' : 'text-gray-500 hover:text-gray-300'}`}
                      >
                        <Pin size={14} className={note.is_pinned ? "fill-blue-400/20" : ""} />
                      </button>
                      <button 
                        onClick={(e) => handleDeleteNote(note.id, e)}
                        className="p-1 text-gray-500 hover:text-red-400 rounded-sm transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5 overflow-hidden">
                      {tags.map((t: string) => (
                        <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-[#333333] text-gray-400">#{t}</span>
                      ))}
                    </div>
                  )}
                  {contentSnippet && (
                    <div className="text-xs text-gray-500 mt-1 truncate">
                      <HighlightText text={contentSnippet} keyword={searchQuery} />
                    </div>
                  )}
                  <div className="text-[10px] text-gray-600 mt-2 font-mono">
                    {formatDate(note.updated_at)}
                  </div>
                </div>
              );
            })
          )}
        </div>
        
        {/* Settings Toggle in Sidebar Bottom */}
        <div className="mt-auto border-t border-[#2B2B2B] p-4 flex items-center justify-between text-gray-400">
          <button onClick={async () => {
            const next = !showSettings;
            setShowSettings(next);
            if (next) {
              try {
                const cfg = await invoke<any>('get_s3_config', {});
                setS3Config(cfg);
              } catch {}
              fetchBackups();
            }
            setS3Status(null);
          }} className="flex items-center gap-2 hover:text-white transition-colors text-sm">
            <Settings size={16} /> 设置
          </button>
        </div>
      </div>

      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col bg-[#1E1E1E] h-full overflow-hidden relative">
        {selectedNote ? (
          <>
            <div className="p-4 border-b border-[#2B2B2B]">
              <div className="flex justify-between items-start mb-3">
                <input 
                  type="text"
                  value={selectedNote.title}
                  onChange={handleTitleChange}
                  className="flex-1 bg-transparent text-2xl font-bold focus:outline-none text-gray-100 placeholder:text-gray-700"
                  placeholder="在此输入标题..."
                />
                
                <div className="flex items-center ml-4 gap-2 shrink-0">
                  <select 
                    value={selectedNote.language || 'markdown'} 
                    onChange={handleLanguageChange}
                    className="bg-[#252526] border border-[#3E3E42] text-gray-400 text-xs rounded-md px-2 py-1.5 focus:outline-none hover:text-gray-200 transition-colors cursor-pointer appearance-none outline-none"
                  >
                    <option value="markdown">Text / Markdown</option>
                    <option value="json">JSON</option>
                    <option value="typescript">TypeScript / JS</option>
                    <option value="html">HTML</option>
                    <option value="css">CSS</option>
                    <option value="rust">Rust</option>
                    <option value="python">Python</option>
                    <option value="sql">SQL</option>
                  </select>
                  <button 
                    onClick={() => {
                      if (!selectedNote) return;
                      setPreviewModes(prev => {
                        const next = { ...prev, [selectedNote.id]: !prev[selectedNote.id] };
                        localStorage.setItem('evernote_lite_preview_modes', JSON.stringify(next));
                        return next;
                      });
                    }}
                    className={`p-1.5 rounded-md transition-colors flex items-center gap-1.5 text-xs ${previewModes[selectedNote.id] ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:text-white hover:bg-[#2B2B2B]'}`}
                  >
                    {previewModes[selectedNote.id] ? <Edit2 size={14} /> : <Eye size={14} />}
                    {previewModes[selectedNote.id] ? '编辑' : '阅读'}
                  </button>
                  <button
                    onClick={handleExport}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1A1A1A] hover:bg-[#2A2A2A] text-gray-400 hover:text-gray-200 transition-colors text-sm"
                  >
                    <Download size={14} />
                    导出
                  </button>
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1A1A1A] hover:bg-[#2A2A2A] text-gray-400 hover:text-gray-200 transition-colors text-sm"
                  >
                    {isCopied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    {isCopied ? '已复制' : '复制全部'}
                  </button>
                </div>
              </div>
              
              {/* Tags Input Area */}
              <div className="flex flex-wrap items-center gap-2">
                <Tag size={14} className="text-gray-600" />
                {JSON.parse(selectedNote.tags || '[]').map((tag: string) => (
                  <span key={tag} className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-[#1A1A1A] border border-[#2A2A2A] text-gray-300">
                    {tag}
                    <button onClick={() => handleRemoveTag(tag)} className="text-gray-500 hover:text-red-400">
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleAddTag}
                  placeholder="添加标签 (回车保存)"
                  className="bg-transparent text-xs text-gray-400 focus:outline-none focus:text-gray-200 placeholder:text-gray-600 min-w-[120px]"
                />
              </div>
            </div>
            
            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
              {previewModes[selectedNote.id] ? (
                <div 
                  className="absolute inset-0 p-6 overflow-y-auto prose prose-invert max-w-none 
                             prose-pre:bg-[#181818] prose-pre:border prose-pre:border-[#2B2B2B]
                             prose-headings:text-gray-200 prose-a:text-blue-400">
                    {selectedNote.content.split('```').map((part, index) => {
                      if (index % 2 !== 0) {
                        const lines = part.split('\n');
                        const lang = lines[0].trim();
                        const code = lines.slice(1).join('\n');
                        return <CodeBlock key={index} code={code} lang={lang} />;
                      } else if (part.trim()) {
                        return (
                          <pre key={index} className="whitespace-pre-wrap font-sans text-gray-300 text-[15px] leading-relaxed my-4">
                            {part}
                          </pre>
                        );
                      }
                      return null;
                    })}
                    {!selectedNote.content && <p className="text-gray-500 italic">空空如也...</p>}
                </div>
              ) : (
                <Editor
                  height="100%"
                  language={selectedNote.language || 'markdown'}
                  theme="vs-dark"
                  value={selectedNote.content}
                  onChange={handleContentChange}
                  onMount={handleEditorDidMount}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    padding: { top: 16, bottom: 16 },
                    lineNumbersMinChars: 3,
                    formatOnPaste: true,
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
            <FileText size={48} className="mb-4 opacity-20" />
            <p className="text-sm">点击左侧笔记查看内容，或新建一个备忘录</p>
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#181818] border border-[#2B2B2B] rounded-lg p-6 w-[480px] shadow-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-semibold">首选项</h2>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white"><X size={18} /></button>
            </div>
            
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-200">开机自动启动</div>
                  <div className="text-xs text-gray-500 mt-1">随系统启动并在后台静默运行</div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={autoStart} onChange={async (e) => {
                    const checked = e.target.checked;
                    try {
                      if (checked) await enable();
                      else await disable();
                      setAutoStart(await isEnabled());
                    } catch(err) { console.error(err); }
                  }} />
                  <div className="w-9 h-5 bg-[#333] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              
              <div className="border-t border-[#2B2B2B] pt-4">
                <div className="font-medium text-gray-200">全局热键</div>
                <div className="text-xs text-gray-500 mt-1">使用 <span className="bg-[#333] px-1.5 py-0.5 rounded text-gray-300 font-mono">Ctrl+Shift+Space</span> 随时呼出/隐藏备忘录</div>
              </div>

              <div className="border-t border-[#2B2B2B] pt-4">
                <div className="font-medium text-gray-200 mb-3">S3 备份</div>
                <div className="space-y-2">
                  <input type="text" placeholder="Endpoint (如 https://s3.amazonaws.com)" value={s3Config.endpoint} onChange={e => setS3Config({...s3Config, endpoint: e.target.value})}
                    className="w-full bg-[#252526] border border-[#3E3E42] rounded-md py-1.5 px-3 text-sm focus:outline-none focus:border-[#555] placeholder:text-gray-600" />
                  <input type="text" placeholder="Bucket" value={s3Config.bucket} onChange={e => setS3Config({...s3Config, bucket: e.target.value})}
                    className="w-full bg-[#252526] border border-[#3E3E42] rounded-md py-1.5 px-3 text-sm focus:outline-none focus:border-[#555] placeholder:text-gray-600" />
                  <input type="text" placeholder="Region (如 us-east-1)" value={s3Config.region} onChange={e => setS3Config({...s3Config, region: e.target.value})}
                    className="w-full bg-[#252526] border border-[#3E3E42] rounded-md py-1.5 px-3 text-sm focus:outline-none focus:border-[#555] placeholder:text-gray-600" />
                  <input type="text" placeholder="Access Key" value={s3Config.access_key} onChange={e => setS3Config({...s3Config, access_key: e.target.value})}
                    className="w-full bg-[#252526] border border-[#3E3E42] rounded-md py-1.5 px-3 text-sm focus:outline-none focus:border-[#555] placeholder:text-gray-600" />
                  <input type="password" placeholder="Secret Key" value={s3Config.secret_key} onChange={e => setS3Config({...s3Config, secret_key: e.target.value})}
                    className="w-full bg-[#252526] border border-[#3E3E42] rounded-md py-1.5 px-3 text-sm focus:outline-none focus:border-[#555] placeholder:text-gray-600" />
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <span className="text-xs text-gray-400 whitespace-nowrap">保留最近</span>
                  <input type="number" min={1} max={1000} value={s3Config.retention} onChange={e => setS3Config({...s3Config, retention: Math.max(1, parseInt(e.target.value) || 30)})}
                    className="w-20 bg-[#252526] border border-[#3E3E42] rounded-md py-1.5 px-2 text-sm focus:outline-none focus:border-[#555]" />
                  <span className="text-xs text-gray-400 whitespace-nowrap">个备份（超出的自动删除）</span>
                </div>
                <button onClick={async () => {
                  try {
                    await invoke('save_s3_config', { config: s3Config });
                    setS3Status('配置已保存');
                    setTimeout(() => setS3Status(null), 3000);
                  } catch (err: any) { setS3Status('保存失败: ' + (err.message || String(err))); }
                }} className="mt-3 w-full py-1.5 rounded-md bg-[#2A2A2A] hover:bg-[#3A3A3A] text-sm text-gray-300 transition-colors">
                  保存配置
                </button>
                <button disabled={s3Loading} onClick={async () => {
                  setS3Loading(true); setS3Status(null);
                  try {
                    const msg = await invoke<string>('backup_to_s3', { trigger: 'manual' });
                    setS3Status(msg);
                    localStorage.setItem('evernote_lite_last_backup', String(Date.now()));
                    fetchBackups();
                  } catch (err: any) { setS3Status('备份失败: ' + (err.message || String(err))); }
                  finally { setS3Loading(false); }
                }} className="mt-3 w-full py-1.5 rounded-md bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-sm transition-colors disabled:opacity-50">
                  {s3Loading ? '处理中...' : '立即备份'}
                </button>
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-300">备份历史</span>
                    <button onClick={fetchBackups} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                      {backupsLoading ? '刷新中...' : '刷新'}
                    </button>
                  </div>
                  {backups.length === 0 && !backupsLoading && (
                    <div className="text-xs text-gray-600 text-center py-3">暂无备份</div>
                  )}
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {backups.map(b => (
                      <div key={b.key} className="flex items-center gap-2 bg-[#252526] rounded-md px-2.5 py-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-gray-300 truncate">{formatBackupTime(b.last_modified)}</div>
                          <div className="text-[10px] text-gray-500 truncate">
                            {b.trigger === 'manual' ? '手动' : '自动'} · {formatSize(b.size)} · {b.name}
                          </div>
                        </div>
                        <button disabled={s3Loading} onClick={async () => {
                          if (!window.confirm(`确定要恢复到 ${formatBackupTime(b.last_modified)} 的备份吗？本地数据将被覆盖。`)) return;
                          setS3Loading(true); setS3Status(null);
                          try {
                            const msg = await invoke<string>('restore_from_s3', { key: b.key });
                            setS3Status(msg);
                            await fetchNotes(searchQuery);
                            setSelectedNote(null);
                          } catch (err: any) { setS3Status('恢复失败: ' + (err.message || String(err))); }
                          finally { setS3Loading(false); }
                        }} className="text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5 disabled:opacity-50">恢复</button>
                        <button disabled={s3Loading} onClick={async () => {
                          if (!window.confirm(`确定删除 ${formatBackupTime(b.last_modified)} 的备份吗？`)) return;
                          setS3Loading(true); setS3Status(null);
                          try {
                            await invoke('delete_backup', { key: b.key });
                            setS3Status('已删除');
                            fetchBackups();
                          } catch (err: any) { setS3Status('删除失败: ' + (err.message || String(err))); }
                          finally { setS3Loading(false); }
                        }} className="text-xs text-red-400/80 hover:text-red-300 px-1.5 py-0.5 disabled:opacity-50">删除</button>
                      </div>
                    ))}
                  </div>
                </div>
                {s3Status && <div className="mt-2 text-xs text-center text-gray-400">{s3Status}</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}

export default App;
