// 导游证随身刷 - Vue 3 核心应用逻辑 (含高精度核验题库、多端云同步、独立用户隔离)
const { createApp, ref, computed, onMounted, onUnmounted, watch } = Vue;

createApp({
  setup() {
    // 冲刺版题库切换：一次性清理旧 ID 缓存，防止错题本与刷题进度串号
    const RUSH_CLEANUP_FLAG = 'daokao_rush_1023_init_done_v1';
    if (!localStorage.getItem(RUSH_CLEANUP_FLAG)) {
      try {
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('daokao_') && k !== RUSH_CLEANUP_FLAG && k !== 'daokao_sync_key') {
            toRemove.push(k);
          }
        }
        toRemove.forEach(k => localStorage.removeItem(k));
        localStorage.setItem(RUSH_CLEANUP_FLAG, '1');
        console.log('[冲刺版清理] 已完成旧版错题本与进度重置，1023题冲刺版全新就绪');
      } catch (e) {
        console.warn('Storage cleanup error:', e);
      }
    }

    // 基础题库与运行状态
    const allQuestions = ref([]);
    const currentChapterFilter = ref('ALL'); // 'ALL' 或具体章节
    const activeMode = ref('text'); // 'text' (文字做题) | 'audio' (耳机听题)
    const practiceMode = ref('all'); // 'all' (全库) | 'wrong' (错题重刷)
    const activeWrongSessionIds = ref([]); // 错题训练会话快照 (防止答对时瞬间切题跳题)
    const PROGRESS_STORAGE_KEY = 'daokao_last_index_rush_1023';
    const savedIndex = parseInt(localStorage.getItem(PROGRESS_STORAGE_KEY) || '0', 10);
    const currentIndex = ref(isNaN(savedIndex) ? 0 : savedIndex);

    // 监听题号变动，自动存入本地存储，防止手机刷新丢失进度
    watch(currentIndex, (newIdx) => {
      localStorage.setItem(PROGRESS_STORAGE_KEY, String(newIdx));
    });
    
    // 答题选择状态 (严格落实答案硬封印)
    const selectedKeys = ref([]); // 支持单选/多选/判断 (如 ['B'] 或 ['A', 'C'])
    const hasAnswered = ref(false); // 是否已提交作答
    const isCorrect = ref(false); // 判定结果

    // 弹窗状态
    const showChapterModal = ref(false);
    const showWrongModal = ref(false);
    const showSyncModal = ref(false); // 跨端同步抽屉
    const showFinishedModal = ref(false); // 本轮刷完全部弹窗

    // 错题账本与做题统计
    const WRONG_STORAGE_KEY = 'daokao_wrong_rush_1023';
    const STATS_STORAGE_KEY = 'daokao_stats_rush_1023';
    const SYNC_KEY_STORAGE = 'daokao_sync_key';
    
    const wrongBook = ref(loadWrongBook());
    const stats = ref(loadStats());

    // ------------------------------------
    // 跨端同步状态 (通用零成本云同步引擎)
    // ------------------------------------
    const syncKey = ref(localStorage.getItem(SYNC_KEY_STORAGE) || '');
    const autoSyncEnabled = ref(localStorage.getItem('daokao_auto_sync') !== 'false');
    const syncStatus = ref('idle'); // 'idle' | 'syncing' | 'synced' | 'error'
    const syncStatusText = ref('未配置口令');
    const lastSyncTime = ref(localStorage.getItem('daokao_last_sync') || '从未同步');
    const importCodeInput = ref('');

    // 公网免费 KV 存储命名空间 (供手机在 4G/5G 户外使用)
    const CLOUD_KV_BUCKET = 'daokao_sync_store_v1';

    // 听题专属状态 (专为戴耳机通勤打造)
    const audioPlaying = ref(false);
    const audioState = ref('idle'); // 'idle' | 'reading_stem' | 'thinking' | 'reading_answer' | 'answered'
    const speechRate = ref(1.05); // 语速 (默认 1.05x 清晰干脆)
    const thinkDuration = ref(5); // 思考倒计时 (3s / 5s / 8s)
    const thinkCountdown = ref(5);
    const voiceInteraction = ref(false);
    let thinkTimer = null;
    let nextQuestionTimer = null;
    let recognitionInstance = null;

    // Web Audio 音效发生器
    let audioCtx = null;
    function playBeep(type = 'ping') {
      try {
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        if (type === 'success') {
          osc.frequency.setValueAtTime(523.25, now);
          osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.12);
          gain.gain.setValueAtTime(0.18, now);
          gain.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
          osc.start(now);
          osc.stop(now + 0.28);
        } else if (type === 'fail') {
          osc.frequency.setValueAtTime(280, now);
          osc.frequency.exponentialRampToValueAtTime(200, now + 0.18);
          gain.gain.setValueAtTime(0.18, now);
          gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
          osc.start(now);
          osc.stop(now + 0.25);
        } else {
          osc.frequency.setValueAtTime(440, now);
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
          osc.start(now);
          osc.stop(now + 0.12);
        }
      } catch (e) {
        console.warn('Audio tone error:', e);
      }
    }

    // 格式化与解析 JSONL 题库
    function parseJsonl(text) {
      const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const parsed = [];
      lines.forEach((line, i) => {
        try {
          const q = JSON.parse(line);
          const type = (q.type || '单选').trim();
          let options = [];
          
          if (type === '判断') {
            options = [
              { key: '√', label: '对 (正确)', text: '正确' },
              { key: '×', label: '错 (错误)', text: '错误' }
            ];
          } else if (type === '简答' || type === '问答') {
            options = [];
          } else if (q.options && typeof q.options === 'object') {
            options = Object.entries(q.options).map(([k, v]) => ({
              key: k,
              label: k,
              text: v
            }));
          }

          parsed.push({
            id: q.id || (i + 1),
            chapter: q.chapter || '导游资格考试综合题库',
            tag: q.tag || '',
            type: type,
            question: q.question,
            options: options,
            rawOptions: q.options || {},
            answer: String(q.answer || '').trim(),
            analysis: q.analysis || q.explanation || '暂无解析'
          });
        } catch (e) {
          console.warn(`第${i+1}行解析失败:`, e);
        }
      });
      return parsed;
    }

    // 加载题库（优先读取本地 questions.jsonl，备用 tourGuideQuestions）
    async function loadQuestionBank() {
      try {
        const resp = await fetch('./questions.jsonl?t=' + Date.now());
        if (resp.ok) {
          const text = await resp.text();
          const items = parseJsonl(text);
          if (items.length > 0) {
            allQuestions.value = items;
            console.log(`已载入高精度核验题库，共 ${items.length} 题`);
            return;
          }
        }
      } catch (err) {
        console.warn('读取 questions.jsonl 失败，使用内置题库', err);
      }

      if (typeof tourGuideQuestions !== 'undefined' && tourGuideQuestions.length) {
        allQuestions.value = tourGuideQuestions.map((q, idx) => ({
          id: q.id || (idx + 1),
          chapter: q.chapter || q.subjectName || '全国导游基础知识',
          tag: q.tag || '',
          type: q.type || '单选',
          question: q.question || q.stem,
          options: q.type === '判断' ? [
            { key: '√', label: '对 (正确)', text: '正确' },
            { key: '×', label: '错 (错误)', text: '错误' }
          ] : (q.options && typeof q.options === 'object' && !Array.isArray(q.options) 
              ? Object.entries(q.options).map(([k, v]) => ({ key: k, label: k, text: v }))
              : (q.options || [])),
          answer: String(q.answer || '').trim(),
          analysis: q.analysis || q.explanation || '暂无解析'
        }));
      }
    }

    function loadWrongBook() {
      try {
        return JSON.parse(localStorage.getItem(WRONG_STORAGE_KEY) || '[]');
      } catch (e) {
        return [];
      }
    }

    function saveWrongBook() {
      localStorage.setItem(WRONG_STORAGE_KEY, JSON.stringify(wrongBook.value));
    }

    function loadStats() {
      try {
        return JSON.parse(localStorage.getItem(STATS_STORAGE_KEY) || '{"totalPracticed": 0, "correctCount": 0, "accuracy": 100}');
      } catch (e) {
        return { totalPracticed: 0, correctCount: 0, accuracy: 100 };
      }
    }

    function saveStats() {
      localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats.value));
    }

    // 章节排序规则与列表（完全按笔试冲刺优先级排列）
    const chapterOrder = [
      '2025年 · 全国统考全真真题卷 (最新)',
      '2024年 · 全国统考全真真题卷',
      '2023年 · 全国统考全真真题卷',
      '科目一 · 政策与法律法规 (核心考点精编)',
      '科目二 · 导游业务 (核心考点精编)',
      '科目三 · 全国导游基础知识 (核心考点精编)',
      '科目四 · 地方导游基础知识 (核心精选)',
      '2020年 · 全国导基统考真题卷',
      '2019年 · 全国统考全真真题卷'
    ];

    const chapterList = computed(() => {
      const set = new Set();
      allQuestions.value.forEach(q => {
        if (q.chapter) set.add(q.chapter);
      });
      const arr = Array.from(set);
      return arr.sort((a, b) => {
        const idxA = chapterOrder.indexOf(a);
        const idxB = chapterOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b, 'zh-CN');
      });
    });

    function getChapterCount(chap) {
      return allQuestions.value.filter(q => q.chapter === chap).length;
    }

    // 题目过滤
    const filteredQuestions = computed(() => {
      let list = allQuestions.value;

      if (practiceMode.value === 'wrong') {
        const ids = activeWrongSessionIds.value.length 
          ? activeWrongSessionIds.value 
          : wrongBook.value.filter(w => !w.fixed).map(w => w.id);
        list = list.filter(q => ids.includes(q.id));
      }

      if (currentChapterFilter.value !== 'ALL') {
        list = list.filter(q => q.chapter === currentChapterFilter.value);
      }

      return list;
    });

    const currentQuestion = computed(() => {
      if (!filteredQuestions.value.length) {
        return {
          id: 0,
          chapter: '无题目',
          type: '单选',
          question: practiceMode.value === 'wrong' ? '太棒了！当前没有任何未攻克的错题！' : '当前章节题库为空',
          options: [],
          answer: '',
          analysis: ''
        };
      }
      return filteredQuestions.value[currentIndex.value] || filteredQuestions.value[0];
    });

    const progressPercent = computed(() => {
      if (!filteredQuestions.value.length) return 0;
      return Math.round(((currentIndex.value + 1) / filteredQuestions.value.length) * 100);
    });

    const currentWrongRecord = computed(() => {
      return wrongBook.value.find(w => w.id === currentQuestion.value.id);
    });

    function normalizeAnswer(str) {
      if (!str) return '';
      let s = String(str).trim().toUpperCase();
      if (s === '对' || s === '正确' || s === 'TRUE' || s === 'T' || s === '1') return '√';
      if (s === '错' || s === '错误' || s === 'FALSE' || s === 'F' || s === '0') return '×';
      return s.replace(/[^A-E√×]/g, '').split('').sort().join('');
    }

    // ------------------------------------
    // 作答逻辑 (答案硬封印与即时判分)
    // ------------------------------------
    function handleOptionClick(key) {
      if (hasAnswered.value) return;

      if (currentQuestion.value.type === '多选') {
        const idx = selectedKeys.value.indexOf(key);
        if (idx > -1) {
          selectedKeys.value.splice(idx, 1);
        } else {
          selectedKeys.value.push(key);
        }
      } else {
        selectedKeys.value = [key];
        submitAnswer();
      }
    }

    function submitAnswer() {
      if (hasAnswered.value) return;
      hasAnswered.value = true;

      const q = currentQuestion.value;
      if (q.type === '简答' || q.type === '问答') {
        isCorrect.value = true;
        playBeep('ping');
        return;
      }

      const myAns = normalizeAnswer(selectedKeys.value.join(''));
      const rightAns = normalizeAnswer(q.answer);

      isCorrect.value = (myAns === rightAns);

      stats.value.totalPracticed += 1;
      if (isCorrect.value) {
        stats.value.correctCount += 1;
        playBeep('success');

        const existing = wrongBook.value.find(w => w.id === q.id);
        if (existing) {
          existing.fixed = true;
          existing.fixedAt = new Date().toLocaleString();
          saveWrongBook();
        }
      } else {
        playBeep('fail');
        recordWrongQuestion(myAns);
      }

      stats.value.accuracy = Math.round((stats.value.correctCount / stats.value.totalPracticed) * 100);
      saveStats();

      // 自动静默触发跨端同步
      if (autoSyncEnabled.value && syncKey.value) {
        triggerAutoSync();
      }
    }

    function markOralResult(pass) {
      const q = currentQuestion.value;
      isCorrect.value = pass;
      stats.value.totalPracticed += 1;
      if (pass) {
        stats.value.correctCount += 1;
        playBeep('success');
        const existing = wrongBook.value.find(w => w.id === q.id);
        if (existing) {
          existing.fixed = true;
          existing.fixedAt = new Date().toLocaleString();
          saveWrongBook();
        }
      } else {
        playBeep('fail');
        recordWrongQuestion('口试未熟记');
        saveWrongBook();
      }
      stats.value.accuracy = Math.round((stats.value.correctCount / stats.value.totalPracticed) * 100);
      saveStats();
      if (autoSyncEnabled.value && syncKey.value) triggerAutoSync();
    }

    function recordWrongQuestion(myAns) {
      const q = currentQuestion.value;
      const idx = wrongBook.value.findIndex(w => w.id === q.id);
      const record = {
        id: q.id,
        chapter: q.chapter,
        type: q.type,
        question: q.question,
        myAnswer: myAns,
        answer: q.answer,
        analysis: q.analysis,
        wrongAt: new Date().toLocaleString(),
        fixed: false
      };

      if (idx > -1) {
        wrongBook.value[idx] = record;
      } else {
        wrongBook.value.unshift(record);
      }
      saveWrongBook();
    }

    function toggleManualWrong() {
      const q = currentQuestion.value;
      const idx = wrongBook.value.findIndex(w => w.id === q.id);
      if (idx > -1) {
        wrongBook.value.splice(idx, 1);
      } else {
        recordWrongQuestion(selectedKeys.value.join('') || '主动收藏');
      }
      saveWrongBook();
      if (autoSyncEnabled.value && syncKey.value) triggerAutoSync();
    }

    function resetQuestionState() {
      selectedKeys.value = [];
      hasAnswered.value = false;
      isCorrect.value = false;
      clearTimeout(nextQuestionTimer);
    }

    function nextQuestion() {
      if (currentIndex.value < filteredQuestions.value.length - 1) {
        currentIndex.value++;
        resetQuestionState();
        if (activeMode.value === 'audio' && audioPlaying.value) {
          playCurrentQuestionAudio();
        }
      } else {
        if (activeMode.value === 'audio' && audioPlaying.value) {
          speakText("恭喜你！本轮题目已全部听记完毕。");
          audioPlaying.value = false;
        }
        showFinishedModal.value = true;
      }
    }

    function restartPractice() {
      currentIndex.value = 0;
      resetQuestionState();
      showFinishedModal.value = false;
    }

    function switchAndPracticeWrong() {
      practiceMode.value = 'wrong';
      currentChapterFilter.value = 'ALL';
      activeWrongSessionIds.value = wrongBook.value.filter(w => !w.fixed).map(w => w.id);
      currentIndex.value = 0;
      resetQuestionState();
      showFinishedModal.value = false;
    }

    function prevQuestion() {
      if (currentIndex.value > 0) {
        currentIndex.value--;
        resetQuestionState();
        if (activeMode.value === 'audio' && audioPlaying.value) {
          playCurrentQuestionAudio();
        }
      }
    }

    function randomNextQuestion() {
      if (filteredQuestions.value.length <= 1) return;
      let nextIdx = currentIndex.value;
      while (nextIdx === currentIndex.value) {
        nextIdx = Math.floor(Math.random() * filteredQuestions.value.length);
      }
      currentIndex.value = nextIdx;
      resetQuestionState();
    }

    function setPracticeMode(mode) {
      practiceMode.value = mode;
      currentIndex.value = 0;
      resetQuestionState();
      if (mode === 'wrong') {
        activeWrongSessionIds.value = wrongBook.value.filter(w => !w.fixed).map(w => w.id);
      } else {
        activeWrongSessionIds.value = [];
      }
      if (activeMode.value === 'audio' && audioPlaying.value) {
        playCurrentQuestionAudio();
      }
    }

    function practiceSpecificWrong(wrongItem) {
      if (wrongItem.fixed) {
        wrongItem.fixed = false;
        saveWrongBook();
      }
      practiceMode.value = 'wrong';
      currentChapterFilter.value = 'ALL';
      showWrongModal.value = false;
      const ids = wrongBook.value.filter(w => !w.fixed).map(w => w.id);
      if (!ids.includes(wrongItem.id)) {
        ids.push(wrongItem.id);
      }
      activeWrongSessionIds.value = ids;
      const targetIdx = ids.indexOf(wrongItem.id);
      currentIndex.value = targetIdx > -1 ? targetIdx : 0;
      resetQuestionState();
      if (activeMode.value === 'audio' && audioPlaying.value) {
        playCurrentQuestionAudio();
      }
    }

    function startWrongPracticeFromModal() {
      practiceMode.value = 'wrong';
      currentChapterFilter.value = 'ALL';
      activeWrongSessionIds.value = wrongBook.value.filter(w => !w.fixed).map(w => w.id);
      currentIndex.value = 0;
      resetQuestionState();
      showWrongModal.value = false;
      if (activeMode.value === 'audio' && audioPlaying.value) {
        playCurrentQuestionAudio();
      }
    }

    function setChapterFilter(chapterName) {
      currentChapterFilter.value = chapterName;
      currentIndex.value = 0;
      resetQuestionState();
      showChapterModal.value = false;
      if (activeMode.value === 'audio' && audioPlaying.value) {
        playCurrentQuestionAudio();
      }
    }

    function clearAllWrong() {
      if (confirm('确定要清空全部错题记录吗？')) {
        wrongBook.value = [];
        saveWrongBook();
        if (autoSyncEnabled.value && syncKey.value) triggerAutoSync();
      }
    }

    function exportWrongBook() {
      if (!wrongBook.value.length) {
        alert('当前暂无错题记录！');
        return;
      }
      let content = `# 导考错题账本备份 (${new Date().toLocaleDateString()})\n\n`;
      wrongBook.value.forEach((w, i) => {
        content += `### 第${i+1}题 【${w.chapter}】(${w.type})\n`;
        content += `题干：${w.question}\n`;
        content += `我的回答：${w.myAnswer} ｜ 正确答案：${w.answer}\n`;
        content += `解析：${w.analysis}\n\n---\n\n`;
      });

      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `导考错题备份_${Date.now()}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function handleFileUpload(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          const items = parseJsonl(text);
          if (items.length) {
            allQuestions.value = items;
            currentChapterFilter.value = 'ALL';
            currentIndex.value = 0;
            resetQuestionState();
            alert(`成功导入 ${items.length} 道新题目！`);
          } else {
            alert('文件解析失败，请确保格式为 JSONL。');
          }
        } catch (err) {
          alert('文件读取出错：' + err.message);
        }
      };
      reader.readAsText(file, 'utf-8');
    }

    // ------------------------------------
    // 跨端双向合并同步核心引擎
    // ------------------------------------
    function generateRandomSyncKey() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = 'DG-';
      for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      syncKey.value = code;
      saveSyncKey();
    }

    function saveSyncKey() {
      localStorage.setItem(SYNC_KEY_STORAGE, syncKey.value.trim());
      localStorage.setItem('daokao_auto_sync', String(autoSyncEnabled.value));
      syncStatusText.value = syncKey.value ? '已绑定专属口令' : '未配置口令';
    }

    function getSyncPayload() {
      return {
        key: syncKey.value.trim(),
        updatedAt: new Date().toISOString(),
        wrongBook: wrongBook.value,
        stats: stats.value,
        currentIndex: currentIndex.value
      };
    }

    // 双向增量合并算法 (保留最新攻克与新增错题)
    function mergeRemoteData(remote) {
      if (!remote) return;
      
      const remoteWrongs = remote.wrongBook || [];
      const localWrongs = wrongBook.value || [];
      const map = new Map();

      localWrongs.forEach(item => map.set(item.id, item));

      remoteWrongs.forEach(remItem => {
        const locItem = map.get(remItem.id);
        if (!locItem) {
          map.set(remItem.id, remItem);
        } else {
          // 只要任一一端攻克了，就标记为已攻克
          const isFixed = locItem.fixed || remItem.fixed;
          map.set(remItem.id, {
            ...locItem,
            ...remItem,
            fixed: isFixed
          });
        }
      });

      wrongBook.value = Array.from(map.values());
      saveWrongBook();

      if (remote.stats) {
        stats.value.totalPracticed = Math.max(stats.value.totalPracticed || 0, remote.stats.totalPracticed || 0);
        stats.value.correctCount = Math.max(stats.value.correctCount || 0, remote.stats.correctCount || 0);
        if (stats.value.totalPracticed > 0) {
          stats.value.accuracy = Math.round((stats.value.correctCount / stats.value.totalPracticed) * 100);
        }
        saveStats();
      }

      // 注意：后台静默同步绝对不能随意篡改用户的当前做题题号 currentIndex，
      // 否则做题过程中会突然无端跳题到远处的题号。

      lastSyncTime.value = new Date().toLocaleTimeString();
      localStorage.setItem('daokao_last_sync', lastSyncTime.value);
    }

    // 触发同步 (先尝试局域网电脑服务，若在户外则走免费公网云端)
    async function doSync(showSuccessAlert = true) {
      if (!syncKey.value.trim()) {
        alert('请先输入或生成一个“专属同步口令”！');
        return;
      }
      saveSyncKey();

      syncStatus.value = 'syncing';
      syncStatusText.value = '正在双向同步中...';

      const payload = getSyncPayload();
      let success = false;

      // 1. 尝试局域网直连同步 (同 Wi-Fi 下直通电脑)
      try {
        const localResp = await fetch('/api/sync?key=' + encodeURIComponent(syncKey.value.trim()), {
          method: 'GET',
          cache: 'no-cache'
        });
        if (localResp.ok) {
          const json = await localResp.json();
          if (json.data) {
            mergeRemoteData(json.data);
          }
          // 推送合并后的最新快照到服务器
          await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: syncKey.value.trim(), data: getSyncPayload() })
          });
          success = true;
          console.log('局域网同步成功');
        }
      } catch (e) {
        console.log('未检测到局域网同步端，尝试公网云同步...', e);
      }

      // 2. 如果局域网不通，走免费公网云端 KV (保证户外 4G/5G 随时同步)
      if (!success) {
        try {
          const cloudUrl = `https://kvdb.io/${CLOUD_KV_BUCKET}/${encodeURIComponent(syncKey.value.trim())}`;
          // 拉取云端
          const getResp = await fetch(cloudUrl, { cache: 'no-cache' });
          if (getResp.ok) {
            const remoteData = await getResp.json();
            mergeRemoteData(remoteData);
          }
          // 上传最新合并数据
          await fetch(cloudUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(getSyncPayload())
          });
          success = true;
          console.log('公网云端 KV 同步成功');
        } catch (err) {
          console.warn('公网云端同步失败:', err);
        }
      }

      if (success) {
        syncStatus.value = 'synced';
        syncStatusText.value = `同步完成 (${lastSyncTime.value})`;
        if (showSuccessAlert) alert('🎉 跨端同步完成！错题账本已无缝合并最新进度。');
      } else {
        syncStatus.value = 'idle';
        syncStatusText.value = '可使用【一键复制同步码】进行微信互传';
        if (showSuccessAlert) alert('暂未连上云端，你可以使用下方的“一键复制同步码”，通过微信发给手机直接导入！');
      }
    }

    // 静默防抖自动同步
    let autoSyncTimer = null;
    function triggerAutoSync() {
      clearTimeout(autoSyncTimer);
      autoSyncTimer = setTimeout(() => {
        doSync(false);
      }, 2000);
    }

    // 零网络依赖口令传输 (微信互发极简导入导出)
    function copySyncToken() {
      const payload = getSyncPayload();
      const code = 'DAOKAO#' + btoa(encodeURIComponent(JSON.stringify(payload)));
      navigator.clipboard.writeText(code).then(() => {
        alert('📋 同步码已复制到剪贴板！\n通过微信发给手机/电脑，在另一端点击“粘贴导入”即可秒级合并！');
      }).catch(() => {
        prompt('请手动复制以下同步码：', code);
      });
    }

    function importSyncToken() {
      let code = importCodeInput.value.trim();
      if (!code) {
        alert('请先粘贴同步码！');
        return;
      }
      try {
        if (code.startsWith('DAOKAO#')) {
          code = code.substring(7);
        }
        const jsonStr = decodeURIComponent(atob(code));
        const data = JSON.parse(jsonStr);
        mergeRemoteData(data);
        importCodeInput.value = '';
        showSyncModal.value = false;
        alert('🎉 成功导入同步码！错题账本已与另一端完全合并。');
      } catch (err) {
        alert('同步码格式无效，请检查是否完整复制！');
      }
    }

    async function forceAppUpdate() {
      if (confirm('确定要清除手机离线强缓存并拉取最新版本题库吗？')) {
        try {
          if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (let r of registrations) {
              await r.unregister();
            }
          }
          if ('caches' in window) {
            const keys = await caches.keys();
            for (let k of keys) {
              await caches.delete(k);
            }
          }
        } catch (e) {
          console.warn('Clear cache error:', e);
        }
        window.location.href = window.location.origin + window.location.pathname + '?v=' + Date.now();
      }
    }

    // ------------------------------------
    // 耳机听题模式逻辑
    // ------------------------------------
    function switchMainMode(mode) {
      activeMode.value = mode;
      if (mode === 'text') {
        stopAudio();
      }
    }

    function speakText(text, onEndCallback) {
      if (!window.speechSynthesis) {
        if (onEndCallback) onEndCallback();
        return;
      }
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = speechRate.value;
      utterance.pitch = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const zhVoice = voices.find(v => /zh|Chinese|普通话|Ting|Mandarin/i.test(v.lang + v.name));
      if (zhVoice) {
        utterance.voice = zhVoice;
      }

      utterance.onend = () => { if (onEndCallback) onEndCallback(); };
      utterance.onerror = (e) => {
        console.warn('TTS error:', e);
        if (onEndCallback) onEndCallback();
      };

      window.speechSynthesis.speak(utterance);
    }

    function playCurrentQuestionAudio() {
      if (!audioPlaying.value) return;
      clearInterval(thinkTimer);
      clearTimeout(nextQuestionTimer);
      resetQuestionState();

      const q = currentQuestion.value;
      audioState.value = 'reading_stem';

      let textToRead = `第${currentIndex.value + 1}题，${q.type}题。${q.question}。`;
      if (q.type === '判断') {
        textToRead += "请判断对错。";
      } else if (q.type === '简答' || q.type === '问答') {
        textToRead += "请在心中默想或口述答题要点。";
      } else if (q.options && q.options.length) {
        textToRead += "选项有：";
        q.options.forEach(opt => {
          textToRead += `${opt.key}，${opt.text}。`;
        });
      }

      speakText(textToRead, () => {
        if (!audioPlaying.value) return;
        startThinkingCountdown();
      });
    }

    function startThinkingCountdown() {
      audioState.value = 'thinking';
      thinkCountdown.value = thinkDuration.value;

      if (voiceInteraction.value) {
        startVoiceListening();
      }

      thinkTimer = setInterval(() => {
        thinkCountdown.value--;
        if (thinkCountdown.value <= 0) {
          clearInterval(thinkTimer);
          if (voiceInteraction.value) stopVoiceListening();
          revealAudioAnswer();
        }
      }, 1000);
    }

    function revealAudioAnswer() {
      audioState.value = 'reading_answer';
      hasAnswered.value = true;
      playBeep('ping');

      const q = currentQuestion.value;
      let ansDisplay = q.answer;
      if (q.type === '判断') {
        ansDisplay = (q.answer === '√' ? '正确' : '错误');
      }

      const answerText = `正确答案是：${ansDisplay}。解析：${q.analysis}`;

      speakText(answerText, () => {
        audioState.value = 'answered';
        if (audioPlaying.value) {
          nextQuestionTimer = setTimeout(() => {
            if (audioPlaying.value) {
              nextQuestion();
            }
          }, 2800);
        }
      });
    }

    function toggleAudioPlay() {
      if (audioPlaying.value) {
        stopAudio();
      } else {
        audioPlaying.value = true;
        playBeep('ping');
        playCurrentQuestionAudio();
      }
    }

    function stopAudio() {
      audioPlaying.value = false;
      audioState.value = 'idle';
      clearInterval(thinkTimer);
      clearTimeout(nextQuestionTimer);
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      stopVoiceListening();
    }

    function fastForwardAudio() {
      if (audioState.value === 'reading_stem' || audioState.value === 'thinking') {
        clearInterval(thinkTimer);
        clearTimeout(nextQuestionTimer);
        stopVoiceListening();
        window.speechSynthesis.cancel();
        revealAudioAnswer();
      } else {
        nextQuestion();
      }
    }

    function setSpeechRate(rate) {
      speechRate.value = rate;
      if (audioPlaying.value) {
        playCurrentQuestionAudio();
      }
    }

    function toggleVoiceInput() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        alert('当前手机浏览器未开放麦克风语音识别，建议使用【自动播报】模式，最省心且抗噪！');
        voiceInteraction.value = false;
        return;
      }
      voiceInteraction.value = !voiceInteraction.value;
    }

    function startVoiceListening() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) return;
      try {
        if (!recognitionInstance) {
          recognitionInstance = new SpeechRecognition();
          recognitionInstance.lang = 'zh-CN';
          recognitionInstance.continuous = false;
          recognitionInstance.interimResults = false;
        }

        recognitionInstance.onresult = (event) => {
          const heard = event.results[0][0].transcript.toUpperCase();
          console.log('麦克风听到:', heard);

          let detected = [];
          if (heard.includes('对') || heard.includes('正确')) detected = ['√'];
          else if (heard.includes('错') || heard.includes('错误')) detected = ['×'];
          else {
            if (heard.includes('A') || heard.includes('诶')) detected.push('A');
            if (heard.includes('B') || heard.includes('必')) detected.push('B');
            if (heard.includes('C') || heard.includes('西')) detected.push('C');
            if (heard.includes('D') || heard.includes('弟')) detected.push('D');
          }

          if (detected.length) {
            selectedKeys.value = detected;
            clearInterval(thinkTimer);
            revealAudioAnswer();
          }
        };

        recognitionInstance.start();
      } catch (e) {
        console.warn('SpeechRecognition error:', e);
      }
    }

    function stopVoiceListening() {
      if (recognitionInstance) {
        try { recognitionInstance.stop(); } catch (e) {}
      }
    }

    const audioStatusText = computed(() => {
      switch (audioState.value) {
        case 'reading_stem': return '🔊 正在为你朗读题目与选项...';
        case 'thinking': return voiceInteraction.value ? '🎙️ 请对着耳机说出答案 (如 B 或 对)...' : '🤔 思考倒计时中...';
        case 'reading_answer': return '📢 正在播报正确答案与考点依据...';
        case 'answered': return '✅ 本题听记完成，即将播报下一题';
        default: return '🎧 插上耳机，轻点下方按钮开始听题';
      }
    });

    const audioStatusColor = computed(() => {
      switch (audioState.value) {
        case 'reading_stem': return 'text-indigo-400';
        case 'thinking': return 'text-amber-400';
        case 'reading_answer': return 'text-blue-400';
        case 'answered': return 'text-emerald-400';
        default: return 'text-slate-300';
      }
    });

    function resetToFirstQuestion() {
      if (confirm('确定要从第 1 题重新开始吗？')) {
        currentIndex.value = 0;
        resetQuestionState();
      }
    }

    onMounted(async () => {
      await loadQuestionBank();
      if (currentIndex.value >= filteredQuestions.value.length && filteredQuestions.value.length > 0) {
        currentIndex.value = 0;
      }
      if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.getVoices();
        };
      }
      // 启动时若配置过同步口令，自动静默同步一次拉取最新进度
      if (syncKey.value && autoSyncEnabled.value) {
        setTimeout(() => { doSync(false); }, 1500);
      }
    });

    onUnmounted(() => {
      stopAudio();
    });

    return {
      allQuestions,
      filteredQuestions,
      currentQuestion,
      currentIndex,
      currentChapterFilter,
      chapterList,
      getChapterCount,
      activeMode,
      practiceMode,
      selectedKeys,
      hasAnswered,
      isCorrect,
      progressPercent,
      stats,
      wrongBook,
      currentWrongRecord,
      showChapterModal,
      showWrongModal,
      showSyncModal,
      showFinishedModal,
      restartPractice,
      switchAndPracticeWrong,

      // 同步相关
      syncKey,
      autoSyncEnabled,
      syncStatus,
      syncStatusText,
      lastSyncTime,
      importCodeInput,
      generateRandomSyncKey,
      saveSyncKey,
      doSync,
      copySyncToken,
      importSyncToken,
      forceAppUpdate,

      // 做题方法
      handleOptionClick,
      submitAnswer,
      markOralResult,
      nextQuestion,
      prevQuestion,
      randomNextQuestion,
      resetToFirstQuestion,
      setPracticeMode,
      practiceSpecificWrong,
      startWrongPracticeFromModal,
      setChapterFilter,
      toggleManualWrong,
      clearAllWrong,
      exportWrongBook,
      handleFileUpload,

      // 听题专属
      audioPlaying,
      audioState,
      speechRate,
      thinkDuration,
      thinkCountdown,
      voiceInteraction,
      audioStatusText,
      audioStatusColor,
      switchMainMode,
      toggleAudioPlay,
      fastForwardAudio,
      setSpeechRate,
      toggleVoiceInput
    };
  }
}).mount('#app');
