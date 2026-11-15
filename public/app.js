(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let data = { posts: [], scheduled: [] };
  let view = 'posts';
  let linkInfo = null;
  let publishImageSource = '';
  let entertainmentNewsItem = null;
  let currentCategory = 'toss';

  function message(value) { $('message').textContent = value; }
  function errorText(err) { return err && err.message ? err.message : String(err); }
  function diagnosticText(diagnostic) {
    if (!diagnostic) return '';
    const parts = [];
    if (diagnostic.httpStatus != null) parts.push('HTTP ' + diagnostic.httpStatus);
    if (diagnostic.endpoint) parts.push('요청 경로 ' + diagnostic.endpoint);
    if (diagnostic.code != null) parts.push('오류 코드 ' + diagnostic.code);
    if (diagnostic.errorSubcode != null) parts.push('하위 코드 ' + diagnostic.errorSubcode);
    if (diagnostic.type) parts.push('유형 ' + diagnostic.type);
    if (diagnostic.fbtraceId) parts.push('FB 추적 ID ' + diagnostic.fbtraceId);
    if (diagnostic.isTransient != null) parts.push('일시적 오류 ' + diagnostic.isTransient);
    if (diagnostic.userTitle) parts.push('Meta 안내 ' + diagnostic.userTitle);
    if (diagnostic.userMessage) parts.push(diagnostic.userMessage);
    if (diagnostic.transportError) parts.push('연결 오류 ' + diagnostic.transportError);
    return parts.join(' | ');
  }
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
      if (!response.ok) {
        const error = new Error(result.error || ('요청 실패 (' + response.status + ')'));
        if (result.diagnostic) error.diagnostic = result.diagnostic;
        throw error;
      }
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
    $('todayDaily').classList.toggle('hidden', isAffiliate);
    entertainmentNewsItem = null;
    $('newsImageWrap').classList.add('hidden');
    $('newsImage').removeAttribute('src');
    $('topicLabel').textContent = isAffiliate ? '상품명' : '조사할 키워드';
    $('topic').placeholder = '';
    $('generate').textContent = isAffiliate ? 'AI 글 생성' : '키워드 조사 후 글 생성';
    $('affiliateLabel').textContent = '토스 쉐어링크';
    linkInfo = null;
    publishImageSource = '';
    $('productImageWrap').classList.add('hidden');
    $('productImage').removeAttribute('src');
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
    $('productImageWrap').classList.add('hidden');
    publishImageSource = '';
    $('productImage').removeAttribute('src');
    try {
      linkInfo = await api('/api/link-preview?url=' + encodeURIComponent(url));
      if (linkInfo.title && !$('topic').value.trim()) $('topic').value = linkInfo.title;
      if (linkInfo.image) {
        publishImageSource = linkInfo.image;
        $('productImage').src = '/api/product-image?url=' + encodeURIComponent(linkInfo.image);
        $('productImageWrap').classList.remove('hidden');
      }
      const details = [linkInfo.title, linkInfo.description].filter(Boolean).join(' / ');
      $('linkInfo').textContent = details ? '읽어온 정보: ' + details : '페이지 제목을 찾지 못했습니다. 상품명을 직접 입력해 주세요.';
      message(linkInfo.image
        ? '상품 대표 사진을 가져왔어요. 게시할 때 자동으로 첨부됩니다.'
        : '상품 정보는 확인했지만 페이지에서 대표 사진을 찾지 못했어요.');
    } catch (err) {
      linkInfo = null;
      $('linkInfo').textContent = '자동으로 읽지 못했습니다. 상품명을 직접 입력해 주세요. 링크는 게시글에 그대로 넣을 수 있어요.';
      message('링크 미리보기: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  });

  $('productImage').addEventListener('error', () => {
    $('productImageWrap').classList.add('hidden');
    publishImageSource = '';
    $('linkInfo').textContent += ' 상품 사진을 불러오지 못했습니다.';
  });


  async function generatePost(todayIssue, todayDaily) {
    const button = todayIssue ? $('todayIssue') : (todayDaily ? $('todayDaily') : $('generate'));
    const topic = $('topic').value.trim();
    if (!todayIssue && !todayDaily && !topic) {
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
    message(todayIssue ? '오늘의 주요 뉴스와 사건 기사를 모으는 중...' : (todayDaily ? '오늘의 일상 글을 만드는 중...' : (currentCategory === 'daily' ? 'Google 뉴스에서 키워드 관련 기사를 조사 중...' : 'AI 글 생성 중...')));
    try {
      const result = await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          category: currentCategory,
          topic,
          productName: currentCategory === 'daily' ? '' : topic,
          todayIssue: Boolean(todayIssue),
          todayDaily: Boolean(todayDaily),
          tone: $('tone').value,
          affiliateLink: $('affiliateLink').value,
          linkInfo
        })
      });
      $('post').value = result.text || '';
      $('comment').value = result.commentText || '';
      message((result.mode || 'AI') + '으로 2단락 게시글' + (todayDaily ? '을 만들었습니다.' : (todayIssue ? '을 만들었습니다.' : '을 생성했습니다.')));
    } catch (err) {
      message('글 생성 실패: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  }

  $('entertainmentNews').addEventListener('click', async () => {
    const button = $('entertainmentNews');
    if ($('category').value !== 'daily') {
      $('category').value = 'daily';
      updateCategoryFields();
    }
    button.disabled = true;
    entertainmentNewsItem = null;
    publishImageSource = '';
    $('newsImageWrap').classList.add('hidden');
    $('newsImage').removeAttribute('src');
    message('실시간 연예계 최신 기사와 대표 사진을 검색하는 중...');
    try {
      const found = await api('/api/entertainment-news');
      const item = found.item;
      if (!item || !item.title || !item.image) throw new Error('기사 제목이나 대표 사진을 찾지 못했습니다.');
      entertainmentNewsItem = item;
      publishImageSource = item.image;
      $('topic').value = item.title;
      $('newsImage').src = '/api/product-image?url=' + encodeURIComponent(item.image);
      $('newsImageWrap').classList.remove('hidden');
      const date = item.publishedAt ? new Date(item.publishedAt) : null;
      const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('ko-KR') : '';
      $('newsInfo').textContent = [item.source, dateText].filter(Boolean).join(' · ') + ' · 게시 시 사진 자동 첨부';
      message('기사 선택 완료. 제목으로 시작하는 Threads 글을 작성 중...');
      const generated = await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          category: 'daily',
          topic: item.title,
          entertainmentNews: true,
          newsItem: item,
          tone: $('tone').value
        })
      });
      $('post').value = generated.text || '';
      $('comment').value = '';
      message('연예계 뉴스 글 생성 완료. 첫 문장은 기사 제목이며, 사진은 게시할 때 자동 첨부돼요.');
    } catch (err) {
      message('연예계 뉴스 생성 실패: ' + errorText(err));
    } finally {
      button.disabled = false;
    }
  });

  $('generate').addEventListener('click', () => generatePost(false));
  $('todayIssue').addEventListener('click', () => generatePost(true, false));
  $('todayDaily').addEventListener('click', () => generatePost(false, true));

  $('publish').addEventListener('click', async () => {
    const text = $('post').value.trim();
    if (!text) { message('게시할 내용을 먼저 작성해 주세요.'); $('post').focus(); return; }
    const button = $('publish');
    button.disabled = true;
    message('Threads에 게시 중...');
    try {
      const result = await api('/api/publish', {
        method: 'POST',
        body: JSON.stringify({ text, commentText: $('comment').value.trim(), category: currentCategory, imageSource: publishImageSource })
      });
      $('post').value = '';
      if (result.commentPosted) {
        $('comment').value = '';
        message('게시글과 첫 댓글 등록 완료.');
      } else if (result.commentError) {
        const diagnostic = diagnosticText(result.commentDiagnostic);
        message('게시글은 등록됐지만 첫 댓글 등록은 실패했어요: ' + result.commentError +
          (diagnostic ? ' | Meta 진단: ' + diagnostic : ''));
      } else {
        $('comment').value = '';
        message('게시글 등록 완료.');
      }
      view = 'posts';
      await refresh();
    } catch (err) {
      const diagnostic = diagnosticText(err.diagnostic);
      message('게시 실패: ' + errorText(err) +
        (diagnostic ? ' | Meta 진단: ' + diagnostic : ''));
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
        body: JSON.stringify({ text, commentText: $('comment').value.trim(), at: $('when').value, category: currentCategory, imageSource: publishImageSource })
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