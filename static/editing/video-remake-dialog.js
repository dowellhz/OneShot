"use strict";

function mountVideoRemake(video, source, brief) {
  const panel = document.createElement("dialog");
  panel.id = "videoRemake";
  panel.setAttribute("aria-labelledby", "rmTitle");
  panel.innerHTML = OneShotI18n.html`<div class="rm-top"><header class="rm-heading"><div><h2 id="rmTitle">视频重制 · 替换角色</h2><span>${esc(video.name)} · 版本 ${video.versions.indexOf(source)+1}</span></div><div class="rm-actions"><button type="button" data-review-next hidden></button><button type="button" data-send-film disabled>送入剪辑</button><button type="button" data-export hidden>合成并保留原声</button><a data-watch target="_blank" rel="noopener" hidden>预览成片</a><a data-download hidden>下载成片</a><button type="button" data-insert-export hidden>成片放入画布</button><button type="button" data-close>返回画布</button></div></header>
    ${brief?`<details class="rm-tasks rm-launch-brief"><summary>创作需求</summary><p>${esc(brief)}</p></details>`:""}
    <details class="rm-tasks" hidden><summary data-task-summary></summary><ul data-task-list></ul></details></div>
    <div class="rm-body">
      <section class="rm-source"><video controls preload="metadata" playsinline></video>
        <div class="rm-actions" data-playback hidden><span class="rm-analysis" data-playback-status role="status"></span>
          <button type="button" data-prepare-playback>生成播放预览</button></div>
        <div class="rm-actions"><button type="button" data-analyze>分析原片</button><span class="rm-analysis"></span>
          <button type="button" data-batch-locate hidden title="在已映射的镜头首帧标出人物位置，供逐镜确认">批量定位人物</button>
          <button type="button" data-batch-previews hidden title="为已确认映射且已圈出人物的镜头生成首帧或首次入画帧">批量生成起始帧</button>
          <button type="button" data-batch-videos hidden title="为已采用首帧或首次入画帧的镜头提交视频生成">批量生成镜头视频</button></div>
        <details class="rm-mapping" hidden>
          <summary>跨镜头人物映射</summary>
          <p class="rm-mapping-status"></p>
          <label>原片人物<select data-person></select></label>
          <label data-manual-label hidden>人物称呼<input data-person-manual maxlength="60" placeholder="例如穿红衣的人"></label>
          <label>原片外貌提示（可选）<input data-person-look maxlength="240" placeholder="例如红色外套、黑色眼镜"></label>
          <label>替换为<select data-map-asset></select></label>
          <fieldset><legend>确认出现该人物的镜头</legend><div data-map-shots></div></fieldset>
          <div class="rm-actions"><button type="button" data-save-mapping>保存映射</button><button type="button" data-clear-mapping hidden>清除映射</button></div>
        </details>
        <nav class="rm-shots" aria-label="原片镜头"></nav>
        <details class="rm-cuts" hidden>
          <summary>调整剪辑点</summary>
          <div class="rm-actions">
            <button type="button" data-step="-1" aria-label="原片后退一帧">−1 帧</button>
            <button type="button" data-step="1" aria-label="原片前进一帧">+1 帧</button>
            <output data-cut-time aria-label="原片播放位置"></output>
          </div>
          <div class="rm-actions">
            <button type="button" data-cut="split_shot">从播放位置拆分</button>
            <button type="button" data-cut="move_cut">移动所选镜头起点</button>
            <button type="button" data-cut="merge_shots">与上一镜头合并</button>
            <button type="button" data-cut="undo_cut" hidden>撤销上次调整</button>
          </div>
        </details>
      </section>
      <section class="rm-editor" hidden>
        <div class="rm-actions"><strong class="rm-shot"></strong><select data-frame aria-label="选取原片画面"></select>
          <button type="button" data-capture-correction>添加当前位置为校正帧</button><button type="button" data-remove-correction hidden>删除校正帧</button>
          <button type="button" data-suggest-entry hidden>查找入画帧</button>
          <button type="button" data-absence hidden>标记人物出画</button></div>
        <p class="rm-summary"></p>
        <div class="rm-actions">
          <select data-layer aria-label="要标记的区域"><option value="selection">替换人物</option><option value="protection">保护前景</option></select>
          <button type="button" data-mode="point" aria-pressed="true">智能点选</button>
          <button type="button" data-mode="box" aria-pressed="false">框选区域</button>
          <button type="button" data-locate-person hidden>定位原片人物</button>
          <button type="button" data-clear-protection hidden>从此帧停止保护</button>
          <span class="rm-selection-status"></span>
        </div>
        <div class="rm-stage">
          <div class="rm-frame"><span>原画面</span><div class="rm-surface"><img class="rm-original" alt="原片画面"><img class="rm-mask" alt="" hidden><img class="rm-mask rm-protection" alt="" hidden><span class="rm-person-point" aria-hidden="true" hidden></span></div></div>
          <div class="rm-frame"><span>替换预览</span><div class="rm-output">生成后显示在这里</div></div>
        </div>
        <div class="rm-actions rm-role">
          <label>替换为<select data-role aria-label="资产库角色"></select></label>
          <label>参考角度<select data-view aria-label="参考角度"></select></label>
          <label class="rm-note">本镜头要求<input maxlength="800" placeholder="例如保留挡在人物前面的桌沿"></label>
          <button type="button" data-generate>生成预览</button>
        </div>
        <div class="rm-actions rm-review" aria-label="预览版本与审核"></div>
        <section class="rm-motion" aria-label="重制镜头">
          <h3>重制这个镜头</h3>
          <p class="rm-motion-hint">先采用首帧预览，再生成视频。</p>
          <div class="rm-actions">
            <button type="button" data-analyze-motion>分析原片动作</button>
            <button type="button" data-use-motion hidden>追加到动作说明</button>
          </div>
          <div class="rm-motion-analysis" hidden>
            <p data-camera-motion></p>
            <ol data-motion-beats aria-label="镜头内的动作时间点"></ol>
          </div>
          <details class="rm-depth">
            <summary>镜头深度参考</summary>
            <p data-depth-status role="status"></p>
            <div class="rm-actions">
              <button type="button" data-prepare-depth>生成深度参考</button>
              <a data-download-depth hidden>下载 MP4</a>
              <button type="button" data-insert-depth hidden>放入画布</button>
            </div>
            <video data-depth-player aria-label="镜头深度参考" preload="metadata" controls playsinline muted hidden></video>
            <div class="rm-depth-send" hidden>
              <div class="rm-actions">
                <label>视频服务<select data-depth-provider></select></label>
                <button type="button" data-generate-depth-video>用深度参考生成</button>
              </div>
              <p data-depth-send-status role="status"></p>
            </div>
          </details>
          <div class="rm-actions">
            <label>动作与运镜<textarea data-motion rows="2" maxlength="1600" placeholder="补充动作时机、人物与道具的互动，或说明镜头如何运动"></textarea></label>
            <button type="button" data-generate-video>生成镜头视频</button>
            <button type="button" data-cut="split_long_shot" hidden>拆分长镜头</button>
          </div>
          <div class="rm-video-result" hidden>
            <div class="rm-actions rm-video-review"></div>
            <video data-result controls preload="metadata" playsinline muted></video>
            <div class="rm-video-status" role="status"></div>
          </div>
        </section>
      </section>
    </div><div class="rm-status" role="status"></div>`;
  document.body.append(panel);
  panel.showModal ? panel.showModal() : panel.setAttribute("open", "");
  return panel;
}
