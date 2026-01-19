/**
 * CurvedLoop - Curved marquee text effect component
 * Standalone JavaScript implementation (no React dependencies)
 */
class CurvedLoop {
  constructor(container, options = {}) {
    // Default options
    this.marqueeText = options.marqueeText || '';
    this.speed = options.speed || 2;
    this.className = options.className || '';
    this.curveAmount = options.curveAmount || 400;
    this.direction = options.direction || 'left';
    this.interactive = options.interactive !== undefined ? options.interactive : true;
    
    // Container element
    this.container = container;
    
    // Refs
    this.measureRef = null;
    this.textPathRef = null;
    this.pathRef = null;
    
    // State
    this.spacing = 0;
    this.offset = 0;
    this.ready = false;
    
    // Drag state
    this.dragActive = false;
    this.lastX = 0;
    this.currentDirection = this.direction;
    this.velocity = 0;
    
    // Animation frame
    this.animationFrame = null;
    
    // Generate unique ID for this instance
    this.uid = 'curve-' + Math.random().toString(36).substring(2, 11);
    
    // Initialize
    this.init();
  }
  
  init() {
    // Process text (add non-breaking space if not present)
    const hasTrailing = /\s|\u00A0$/.test(this.marqueeText);
    this.text = (hasTrailing ? this.marqueeText.replace(/\s+$/, '') : this.marqueeText) + '\u00A0';
    
    // Create SVG structure
    this.createSVG();
    
    // Measure text
    this.measureText();
    
    // Start animation
    this.startAnimation();
  }
  
  createSVG() {
    // Adjust curve amount based on screen size
    const isMobile = window.innerWidth <= 768;
    const adjustedCurve = isMobile ? this.curveAmount * 0.5 : this.curveAmount;
    const viewBoxHeight = isMobile ? 100 : 120;
    
    const pathD = `M-100,40 Q500,${40 + adjustedCurve} 1540,40`;
    
    const svgHTML = `
      <div class="curved-loop-jacket" style="visibility: hidden; cursor: ${this.interactive ? 'grab' : 'auto'};">
        <svg class="curved-loop-svg" viewBox="0 0 1440 ${viewBoxHeight}">
          <text class="measure-text" xml:space="preserve" style="visibility: hidden; opacity: 0; pointer-events: none;">
            ${this.text}
          </text>
          <defs>
            <path id="${this.uid}" d="${pathD}" fill="none" stroke="transparent" />
            <linearGradient id="curved-text-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:#db2c1a;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#f89429;stop-opacity:1" />
            </linearGradient>
          </defs>
          <text font-weight="bold" xml:space="preserve" class="${this.className} main-text">
            <textPath href="#${this.uid}" startOffset="0px" xml:space="preserve">
            </textPath>
          </text>
        </svg>
      </div>
    `;
    
    this.container.innerHTML = svgHTML;
    
    // Get references
    this.measureRef = this.container.querySelector('.measure-text');
    this.textPathRef = this.container.querySelector('textPath');
    this.pathRef = this.container.querySelector(`#${this.uid}`);
    this.jacketRef = this.container.querySelector('.curved-loop-jacket');
    
    // Add event listeners if interactive
    if (this.interactive) {
      this.jacketRef.addEventListener('pointerdown', this.onPointerDown.bind(this));
      this.jacketRef.addEventListener('pointermove', this.onPointerMove.bind(this));
      this.jacketRef.addEventListener('pointerup', this.endDrag.bind(this));
      this.jacketRef.addEventListener('pointerleave', this.endDrag.bind(this));
    }
  }
  
  measureText() {
    if (this.measureRef) {
      this.spacing = this.measureRef.getComputedTextLength();
      
      if (this.spacing > 0) {
        // Calculate how many repetitions we need
        const repetitions = Math.ceil(1800 / this.spacing) + 2;
        const totalText = Array(repetitions).fill(this.text).join('');
        
        // Set the text content
        this.textPathRef.textContent = totalText;
        
        // Set initial offset
        const initial = -this.spacing;
        this.textPathRef.setAttribute('startOffset', initial + 'px');
        this.offset = initial;
        
        // Mark as ready and show
        this.ready = true;
        this.jacketRef.style.visibility = 'visible';
      }
    }
  }
  
  startAnimation() {
    const step = () => {
      if (!this.dragActive && this.textPathRef && this.ready) {
        const delta = this.currentDirection === 'right' ? this.speed : -this.speed;
        const currentOffset = parseFloat(this.textPathRef.getAttribute('startOffset') || '0');
        let newOffset = currentOffset + delta;
        
        // Wrap around
        const wrapPoint = this.spacing;
        if (newOffset <= -wrapPoint) newOffset += wrapPoint;
        if (newOffset > 0) newOffset -= wrapPoint;
        
        this.textPathRef.setAttribute('startOffset', newOffset + 'px');
        this.offset = newOffset;
      }
      this.animationFrame = requestAnimationFrame(step);
    };
    
    this.animationFrame = requestAnimationFrame(step);
  }
  
  onPointerDown(e) {
    if (!this.interactive) return;
    this.dragActive = true;
    this.lastX = e.clientX;
    this.velocity = 0;
    e.target.setPointerCapture(e.pointerId);
    this.jacketRef.style.cursor = 'grabbing';
  }
  
  onPointerMove(e) {
    if (!this.interactive || !this.dragActive || !this.textPathRef) return;
    
    const dx = e.clientX - this.lastX;
    this.lastX = e.clientX;
    this.velocity = dx;
    
    const currentOffset = parseFloat(this.textPathRef.getAttribute('startOffset') || '0');
    let newOffset = currentOffset + dx;
    
    // Wrap around
    const wrapPoint = this.spacing;
    if (newOffset <= -wrapPoint) newOffset += wrapPoint;
    if (newOffset > 0) newOffset -= wrapPoint;
    
    this.textPathRef.setAttribute('startOffset', newOffset + 'px');
    this.offset = newOffset;
  }
  
  endDrag() {
    if (!this.interactive) return;
    this.dragActive = false;
    this.currentDirection = this.velocity > 0 ? 'right' : 'left';
    this.jacketRef.style.cursor = 'grab';
  }
  
  destroy() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CurvedLoop;
}
