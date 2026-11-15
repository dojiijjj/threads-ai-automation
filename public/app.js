(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let data = { posts: [], scheduled: [] };
  let view = 'posts';
  let linkInfo = null;
  let currentCategory = 'toss';

  function message(value) { $('message').textContent = value; }
  function errorText(err) { return err && err.message ? err.message : String(err); }
  function extractHttpUrl(value) {
    const match = String(value || '').match(/https?:\/\/[^\s<>"'`]+/i);
    return match ? match[0].replace(/[.,!?;:，。！？；：)\]}》〉」』】]+$/u, '') : '';
  }
  function categoryLabel(value) {
    return value === 'toss' ? '토스' : value === 'coupang' ? '쿠팡' : '일상';
  }

  async function api(url, options) {
    const opts = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, Object.assign({}, opts, { headers, signal: controller.signal }));
      let result;
      try { result = await response.json(); }
      catch (_) { throw new Error('서버 응답을 읽을 수 없습니다.'); }
      if (!response.ok) throw new Error(result.error || ('요청 실패 (' + response.status + ')'));
      return result;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('요청 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요.');
      throw err;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function addText(parent, tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    parent.appendChild(node);
    return node;
  }

  function updateCategoryFields() {
    currentCategory = $('category').value;
    const isAffiliate = currentCategory !== 'daily';
    $('affiliateWrap').classList.toggle('hidden', !isAffiliate);
    $('linkPreview').classList.toggle('hidden', !isAffiliate);
    $('todayIssue').classList.toggle('hidden', isAffiliate);
    $('topicLabel').textContent = isAffiliate ? '상품명' : '조사할 키워드';
    $('topic').placeholder = isAffiliate
      ? '상품명 입력'
      : '예: 부산 화재, 전기차 보조금, AI 규제';
    $('generate').textContent = isAffiliate ? 'AI 글 생성' : '키워드 조사 후 글 생성';
    $('affiliateLabel').textContent = '토스 쉐어링크';
    linkInfo = null;
    $('linkInfo').textContent = '';
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
      addText(box, 'span', 'pill', '[' + categoryLabel(item.category || 'daily') + '] ' + (item.status || '') + (shownTime ? ' · ' + shownTime : ''));
      if (item.commentStatus) addText(box, 'span', 'pill', ' · 첫 댓글: ' + item.commentStatus);
      addText(box, 'p', '', item.text || '');
      if (view === 'posts' && item.commentStatus === '댓글 등록 실패' && item.commentText) {
        const retry = document.createElement('button');
        retry.className = 'secondary';
        retry.type = 'button';
        retry.textContent = '첫 댓글 다시 등록';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          message('첫 댓글 다시 등록 중...');
          try {
            await api('/api/reply', {
              method: 'POST',
              body: JSON.stringify({ postId: item.id, text: item.commentText })
            });
            message('첫 댓글을 등록했습니다.');
            await refresh();
          } catch (err) {
            message('댓글 등록 실패: ' + errorText(err));
            retry.disabled = false;
          }
        });
        box.appendChild(retry);
      }
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

  $('category').addEventListener('change', updateCategoryFields);

  $('linkPreview').addEventListener('click', async () => {
    const url = extractHttpUrl($('affiliateLink').value);
    if (!url) { message('입력한 내용에서 https:// 또는 http:// 링크를 찾지 못했어요.'); $('affiliateLink').focus(); return; }
    const button = $('linkPreview');
    button.disabled = true;
    $('linkInfo').textContent = '상품 페이지 정보를 읽는 중...';
    try {
      linkInfo = await api('/api/link-preview?url=' + encodeURIComponent(url));
      if (linkInfo.title && !$('topic').value.trim()) $('topic').value = linkInfo.title;
      const details = [linkInfo.title, linkInfo.description].filter(Boolean).join(' / ');
      $('linkInfo').textContent = details ? '읽어온 정보: ' + details : '페이지 제목을 찾지 못했습니다. 상품명을 직접 입력해 주세요.';
      message('링크 정보 확인 완료. 상품명과 설명을 확인해 주세요.');
    } catch (err) {
      linkInfo = null;
      $('linkInfo').textContent = '자동으로 읽지 못했습니다. 상품명을 직접 입력해 주세요. 링크는 게시글에 그대로 넣을 수 있어요.';
      message('링크 미리보기: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  });

  async function generatePost(todayIssue) {
    const button = todayIssue ? $('todayIssue') : $('generate');
    const topic = $('topic').value.trim();
    if (!todayIssue && !topic) {
      message('조사할 키워드를 입력해 주세요.');
      $('topic').focus();
      return;
    }
    if (!todayIssue && currentCategory !== 'daily' && !$('affiliateLink').value.trim()) {
      message('제휴 링크를 붙여 넣어 주세요.');
      $('affiliateLink').focus();
      return;
    }
    button.disabled = true;
    message(todayIssue ? '오늘의 주요 뉴스와 사건 기사를 모으는 중...' : (currentCategory === 'daily' ? 'Google 뉴스에서 키워드 관련 기사를 조사 중...' : 'AI 글 생성 중...'));
    try {
      const result = await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          category: currentCategory,
          topic,
          productName: currentCategory === 'daily' ? '' : topic,
          todayIssue: Boolean(todayIssue),
          tone: $('tone').value,
          affiliateLink: $('affiliateLink').value,
          linkInfo
        })
      });
      $('post').value = result.text || '';
      $('comment').value = result.commentText || '';
      message((result.mode || 'AI') + '으로 3단락 게시글' + (todayIssue ? '을 만들었습니다.' : '을 생성했습니다.'));
    } catch (err) {
      message('글 생성 실패: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  }

  $('generate').addEventListener('click', () => generatePost(false));
  $('todayIssue').addEventListener('click', () => generatePost(true));

  $('publish').addEventListener('click', async () => {
    const text = $('post').value.trim();
    if (!text) { message('게시할 내용을 먼저 작성해 주세요.'); $('post').focus(); return; }
    const button = $('publish');
    button.disabled = true;
    message('Threads에 게시 중...');
    try {
      const result = await api('/api/publish', {
        method: 'POST',
        body: JSON.stringify({ text, commentText: $('comment').value.trim(), category: currentCategory })
      });
      $('post').value = '';
      if (result.commentPosted) {
        $('comment').value = '';
        message('게시글과 첫 댓글 등록 완료.');
      } else if (result.commentError) {
        message('게시글은 등록됐지만 첫 댓글 등록은 실패했어요: ' + result.commentError);
      } else {
        $('comment').value = '';
        message('게시글 등록 완료.');
      }
      view = 'posts';
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
        body: JSON.stringify({ text, commentText: $('comment').value.trim(), at: $('when').value, category: currentCategory })
      });
      message(categoryLabel(currentCategory) + ' 게시글과 첫 댓글 예약 등록 완료.');
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

  updateCategoryFields();
  message('화면 스크립트가 실행됐습니다. 서버 연결 확인 중...');
  refresh();
  window.setInterval(refresh, 20000);
})();