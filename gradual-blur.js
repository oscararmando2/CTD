/**
 * GradualBlur - Vanilla JavaScript implementation
 * Creates a gradual blur effect at the edges of an element
 */

class GradualBlur {
  constructor(element, options = {}) {
    this.element = element;
    this.config = {
      position: options.position || 'bottom',
      strength: options.strength || 2,
      height: options.height || '7rem',
      divCount: options.divCount || 5,
      exponential: options.exponential || false,
      curve: options.curve || 'bezier',
      opacity: options.opacity !== undefined ? options.opacity : 1,
      ...options
    };
    
    this.init();
  }
  
  init() {
    // Ensure parent element has position relative
    const parentPosition = window.getComputedStyle(this.element).position;
    if (parentPosition === 'static') {
      this.element.style.position = 'relative';
    }
    
    // Ensure parent has overflow hidden for proper effect
    this.element.style.overflow = 'hidden';
    
    // Create blur container
    this.createBlurContainer();
  }
  
  getGradientDirection() {
    const directions = {
      top: 'to top',
      bottom: 'to bottom',
      left: 'to left',
      right: 'to right'
    };
    return directions[this.config.position] || 'to bottom';
  }
  
  getCurveFunction(p) {
    const curves = {
      linear: p => p,
      bezier: p => p * p * (3 - 2 * p),
      'ease-in': p => p * p,
      'ease-out': p => 1 - Math.pow(1 - p, 2),
      'ease-in-out': p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)
    };
    return (curves[this.config.curve] || curves.linear)(p);
  }
  
  createBlurContainer() {
    const container = document.createElement('div');
    container.className = 'gradual-blur-container';
    
    // Set container styles
    const isVertical = ['top', 'bottom'].includes(this.config.position);
    const baseStyle = {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '10'
    };
    
    if (isVertical) {
      container.style.height = this.config.height;
      container.style.width = '100%';
      container.style[this.config.position] = '0';
      container.style.left = '0';
      container.style.right = '0';
    } else {
      container.style.width = this.config.height;
      container.style.height = '100%';
      container.style[this.config.position] = '0';
      container.style.top = '0';
      container.style.bottom = '0';
    }
    
    Object.assign(container.style, baseStyle);
    
    // Create inner container
    const inner = document.createElement('div');
    inner.className = 'gradual-blur-inner';
    inner.style.position = 'relative';
    inner.style.width = '100%';
    inner.style.height = '100%';
    
    // Create blur divs
    const increment = 100 / this.config.divCount;
    const direction = this.getGradientDirection();
    
    for (let i = 1; i <= this.config.divCount; i++) {
      let progress = i / this.config.divCount;
      progress = this.getCurveFunction(progress);
      
      let blurValue;
      if (this.config.exponential) {
        blurValue = Math.pow(2, progress * 4) * 0.0625 * this.config.strength;
      } else {
        blurValue = 0.0625 * (progress * this.config.divCount + 1) * this.config.strength;
      }
      
      const p1 = Math.round((increment * i - increment) * 10) / 10;
      const p2 = Math.round(increment * i * 10) / 10;
      const p3 = Math.round((increment * i + increment) * 10) / 10;
      const p4 = Math.round((increment * i + increment * 2) * 10) / 10;
      
      let gradient = `transparent ${p1}%, black ${p2}%`;
      if (p3 <= 100) gradient += `, black ${p3}%`;
      if (p4 <= 100) gradient += `, transparent ${p4}%`;
      
      const blurDiv = document.createElement('div');
      blurDiv.style.position = 'absolute';
      blurDiv.style.inset = '0';
      blurDiv.style.maskImage = `linear-gradient(${direction}, ${gradient})`;
      blurDiv.style.webkitMaskImage = `linear-gradient(${direction}, ${gradient})`;
      blurDiv.style.backdropFilter = `blur(${blurValue.toFixed(3)}rem)`;
      blurDiv.style.webkitBackdropFilter = `blur(${blurValue.toFixed(3)}rem)`;
      blurDiv.style.opacity = this.config.opacity;
      
      inner.appendChild(blurDiv);
    }
    
    container.appendChild(inner);
    this.element.appendChild(container);
    this.container = container;
  }
  
  destroy() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GradualBlur;
}
