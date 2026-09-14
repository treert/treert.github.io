/**
 * 播放循环。
 *
 * 用 requestAnimationFrame 做节拍，配合一个时间累加器把"每秒演化多少代"
 * 和屏幕刷新率解耦：1 代/秒和 200 代/秒都能稳定跑，也不会在 144Hz 屏上变快。
 * 单帧演化代数有上限，防止大棋盘上卡住页面。
 */
export class Simulator {
  /**
   * @param {{step: ()=>void, onAdvance: (n:number)=>void, maxStepsPerFrame: number}} options
   */
  constructor({ step, onAdvance, maxStepsPerFrame }) {
    this.step = step;
    this.onAdvance = onAdvance;
    this.maxStepsPerFrame = maxStepsPerFrame;

    this.playing = false;
    this.gps = 10;
    this._acc = 0;
    this._last = 0;
    this._raf = 0;
    this._tick = this._tick.bind(this);
  }

  setSpeed(gps) {
    this.gps = gps;
    this._acc = 0;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._last = performance.now();
    this._acc = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 手动单步 */
  stepOnce() {
    this.step();
    this.onAdvance(1);
  }

  _tick(now) {
    if (!this.playing) return;

    // 切后台再回来时 dt 会很大，钳一下免得一次补上几千代
    const dt = Math.min(now - this._last, 250) / 1000;
    this._last = now;
    this._acc += dt * this.gps;

    let n = Math.floor(this._acc);
    if (n > this.maxStepsPerFrame) n = this.maxStepsPerFrame;

    if (n > 0) {
      this._acc -= n;
      if (this._acc > this.maxStepsPerFrame) this._acc = this.maxStepsPerFrame;
      for (let i = 0; i < n; i++) this.step();
      this.onAdvance(n);
    }

    this._raf = requestAnimationFrame(this._tick);
  }
}
