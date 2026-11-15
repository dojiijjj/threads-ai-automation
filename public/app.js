(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let data = { posts: [], scheduled: [] };
  let view = 'posts';

  function message(value) { $('message').textContent = value; }
  function errorText(err) { return err && err.message ? err.message : String(err); }

  async function api(url, options) {
    const opts = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const response = await fetch(url, Object.assign({}, opts, { headers }));
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error('서버 응답을 읽을 수 없습니다.'); }
    if (!response.ok) throw new Error(result.error || ('요청 실패 (' + response.status + ')'));
    return result;
  }

  function addText(parent, tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    parent.appendChild(node);
    return node;
  }

  function render() {
    const list = $('list');
    list.replaceChildren();
    const rows = view === 'posts' ? data.posts : data.scheduled;
    if (!Array.isArray(rows) || rows.length === 0) {
      addText(list, 'p', 'muted', '표시할 내역이 없습니다.');
      return;
    }
    rows.forEach((item) => {
      const box = document.createElement('div');
      box.className = 'item';
      const time = view === 'posts' ? item.createdAt : item.at;
      let shownTime = '';
      if (time) {
        const parsed = new Date(time);
        shownTime = Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
      }
      addText(box, 'span', 'pill', (item.status || '') + (shownTime ? ' · ' + shownTime : ''));
      addText(box, 'p', '', item.text || '');
      if (view === 'scheduled' && item.status === '예약 대기') {
        const cancel = document.createElement('button');
        cancel.className = 'danger';
        cancel.type = 'button';
        cancel.textContent = '예약 취소';
        cancel.addEventListener('click', async () => {
          cancel.disabled = true;
          try {
            await api('/api/schedule/' + encodeURIComponent(item.id), { method: 'DELETE' });
            message('예약을 취소했습니다.');
            await refresh();
          } catch (err) {
            message(errorText(err));
            cancel.disabled = false;
          }
        });
        box.appendChild(cancel);
      }
      list.appendChild(box);
    });
  }

  async function refresh() {
    try {
      const status = await api('/api/status');
      if (status.username) $('status').textContent = '@' + status.username + ' 연결됨';
      else if (status.error) $('status').textContent = 'Threads 토큰 확인 필요';
      else if (status.configured) $('status').textContent = 'Threads 토큰 등록됨';
      else $('status').textContent = 'Threads 토큰 미등록';
    } catch (err) {
      $('status').textContent = '서버 연결 오류';
      message('상태 확인 실패: ' + errorText(err));
    }
    try {
      data = await api('/api/posts');
      render();
    } catch (err) {
      message('게시 기록 불러오기 실패: ' + errorText(err));
    }
  }

  $('generate').addEventListener('click', async () => {
    const button = $('generate');
    const topic = $('topic').value.trim();
    if (!topic) { message('먼저 게시글 주제를 입력해 주세요.'); $('topic').focus(); return; }
    button.disabled = true;
    message('AI 글 생성 중...');
    try {
      const result = await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ topic: topic, tone: $('tone').value })
      });
      $('post').value = result.text || '';
      message((result.mode || 'AI') + ' 글 생성 완료. 내용을 확인해 주세요.');
    } catch (err) {
      message('글 생성 실패: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  });

  $('publish').addEventListener('click', async () => {
    const text = $('post').value.trim();
    if (!text) { message('게시할 내용을 먼저 작성해 주세요.'); $('post').focus(); return; }
    const button = $('publish');
    button.disabled = true;
    message('Threads에 게시 중...');
    try {
      await api('/api/publish', { method: 'POST', body: JSON.stringify({ text: text }) });
      $('post').value = '';
      view = 'posts';
      message('게시 완료.');
      await refresh();
    } catch (err) {
      message('게시 실패: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  });

  $('showSchedule').addEventListener('click', () => {
    $('scheduleBox').classList.toggle('hidden');
  });

  $('schedule').addEventListener('click', async () => {
    const text = $('post').value.trim();
    if (!text) { message('예약할 게시글 내용을 먼저 입력해 주세요.'); $('post').focus(); return; }
    if (!$('when').value) { message('예약 시간을 선택해 주세요.'); return; }
    const button = $('schedule');
    button.disabled = true;
    try {
      await api('/api/schedule', {
        method: 'POST',
        body: JSON.stringify({ text: text, at: $('when').value })
      });
      message('예약 등록 완료.');
      $('scheduleBox').classList.add('hidden');
      view = 'scheduled';
      await refresh();
    } catch (err) {
      message('예약 실패: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  });

  $('historyTab').addEventListener('click', () => { view = 'posts'; render(); });
  $('scheduledTab').addEventListener('click', () => { view = 'scheduled'; render(); });

  window.addEventListener('error', (event) => {
    message('화면 오류: ' + (event.message || '자바스크립트 오류'));
  });
  window.addEventListener('unhandledrejection', (event) => {
    message('처리하지 못한 오류: ' + errorText(event.reason));
  });

  message('화면 스크립트가 실행됐습니다. 서버 연결 확인 중...');
  refresh();
  window.setInterval(refresh, 20000);
})();