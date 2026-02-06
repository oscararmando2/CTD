/**
 * LogoLoop - Smooth infinite logo carousel component
 * Standalone JavaScript implementation (no React dependencies)
 */
class LogoLoop {
  constructor(container, options = {}) {
    // Configuration
    this.logos = options.logos || [];
    this.speed = options.speed || 120;
    this.direction = options.direction || 'left';
    this.logoHeight = options.logoHeight || 28;
    this.gap = options.gap || 32;
    this.pauseOnHover = options.pauseOnHover !== undefined ? options.pauseOnHover : true;
    this.hoverSpeed = options.hoverSpeed !== undefined ? options.hoverSpeed : 0;
    this.fadeOut = options.fadeOut !== undefined ? options.fadeOut : false;
    this.fadeOutColor = options.fadeOutColor;
    this.scaleOnHover = options.scaleOnHover !== undefined ? options.scaleOnHover : false;
    this.ariaLabel = options.ariaLabel || 'Partner logos';
    
    // Container element
    this.container = container;
    
    // State
    this.seqWidth = 0;
    this.seqHeight = 0;
    this.copyCount = 2;
    this.isHovered = false;
    
    // Animation
    this.rafRef = null;
    this.lastTimestamp = null;
    this.offset = 0;
    this.velocity = 0;
    
    // Constants
    this.SMOOTH_TAU = 0.25;
    this.MIN_COPIES = 2;
    this.COPY_HEADROOM = 2;
    
    // Refs
    this.trackElement = null;
    this.seqElement = null;
    
    // Initialize
    this.init();
  }
  
  init() {
    this.createStructure();
    this.setupEventListeners();
    this.updateDimensions();
    this.startAnimation();
  }
  
  createStructure() {
    const isVertical = this.direction === 'up' || this.direction === 'down';
    
    // Calculate effective hover speed
    let effectiveHoverSpeed = 0;
    if (this.hoverSpeed !== undefined) {
      effectiveHoverSpeed = this.hoverSpeed;
    } else if (this.pauseOnHover === true) {
      effectiveHoverSpeed = 0;
    }
    
    // Build class names
    const rootClasses = [
      'logoloop',
      isVertical ? 'logoloop--vertical' : 'logoloop--horizontal',
      this.fadeOut && 'logoloop--fade',
      this.scaleOnHover && 'logoloop--scale-hover'
    ].filter(Boolean).join(' ');
    
    // Create container structure
    this.container.className = rootClasses;
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', this.ariaLabel);
    
    // Set CSS variables
    this.container.style.setProperty('--logoloop-gap', `${this.gap}px`);
    this.container.style.setProperty('--logoloop-logoHeight', `${this.logoHeight}px`);
    if (this.fadeOutColor) {
      this.container.style.setProperty('--logoloop-fadeColor', this.fadeOutColor);
    }
    
    // Create track
    this.trackElement = document.createElement('div');
    this.trackElement.className = 'logoloop__track';
    this.container.appendChild(this.trackElement);
    
    // Create initial copies
    this.updateCopies();
  }
  
  updateCopies() {
    // Clear existing content
    this.trackElement.innerHTML = '';
    
    // Create copies
    for (let copyIndex = 0; copyIndex < this.copyCount; copyIndex++) {
      const list = document.createElement('ul');
      list.className = 'logoloop__list';
      list.setAttribute('role', 'list');
      if (copyIndex > 0) {
        list.setAttribute('aria-hidden', 'true');
      }
      
      // Store reference to first sequence
      if (copyIndex === 0) {
        this.seqElement = list;
      }
      
      // Add logo items
      this.logos.forEach((logo, itemIndex) => {
        const item = this.createLogoItem(logo, `${copyIndex}-${itemIndex}`);
        list.appendChild(item);
      });
      
      this.trackElement.appendChild(list);
    }
  }
  
  createLogoItem(logo, key) {
    const li = document.createElement('li');
    li.className = 'logoloop__item';
    li.setAttribute('role', 'listitem');
    
    // Create image element
    const img = document.createElement('img');
    img.src = logo.src;
    if (logo.srcSet) img.srcSet = logo.srcSet;
    if (logo.sizes) img.sizes = logo.sizes;
    if (logo.width) img.width = logo.width;
    if (logo.height) img.height = logo.height;
    img.alt = logo.alt || '';
    if (logo.title) img.title = logo.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    
    // Wrap in link if href is provided
    if (logo.href) {
      const link = document.createElement('a');
      link.className = 'logoloop__link';
      link.href = logo.href;
      link.setAttribute('aria-label', logo.alt || logo.title || 'logo link');
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.appendChild(img);
      li.appendChild(link);
    } else {
      li.appendChild(img);
    }
    
    return li;
  }
  
  setupEventListeners() {
    // Mouse enter/leave for hover effects
    this.trackElement.addEventListener('mouseenter', () => {
      if (this.hoverSpeed !== undefined || this.pauseOnHover) {
        this.isHovered = true;
      }
    });
    
    this.trackElement.addEventListener('mouseleave', () => {
      if (this.hoverSpeed !== undefined || this.pauseOnHover) {
        this.isHovered = false;
      }
    });
    
    // Resize observer
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateDimensions();
      });
      this.resizeObserver.observe(this.container);
      if (this.seqElement) {
        this.resizeObserver.observe(this.seqElement);
      }
    } else {
      window.addEventListener('resize', () => {
        this.updateDimensions();
      });
    }
    
    // Wait for images to load
    this.waitForImages();
  }
  
  waitForImages() {
    const images = this.seqElement?.querySelectorAll('img') || [];
    if (images.length === 0) {
      this.updateDimensions();
      return;
    }
    
    let remainingImages = images.length;
    const handleImageLoad = () => {
      remainingImages -= 1;
      if (remainingImages === 0) {
        this.updateDimensions();
      }
    };
    
    images.forEach(img => {
      if (img.complete) {
        handleImageLoad();
      } else {
        img.addEventListener('load', handleImageLoad, { once: true });
        img.addEventListener('error', handleImageLoad, { once: true });
      }
    });
  }
  
  updateDimensions() {
    const containerWidth = this.container.clientWidth;
    const sequenceRect = this.seqElement?.getBoundingClientRect();
    const sequenceWidth = sequenceRect?.width || 0;
    const sequenceHeight = sequenceRect?.height || 0;
    
    const isVertical = this.direction === 'up' || this.direction === 'down';
    
    if (isVertical) {
      const parentHeight = this.container.parentElement?.clientHeight || 0;
      if (parentHeight > 0) {
        this.container.style.height = `${Math.ceil(parentHeight)}px`;
      }
      if (sequenceHeight > 0) {
        this.seqHeight = Math.ceil(sequenceHeight);
        const viewport = this.container.clientHeight || parentHeight || sequenceHeight;
        const copiesNeeded = Math.ceil(viewport / sequenceHeight) + this.COPY_HEADROOM;
        const newCopyCount = Math.max(this.MIN_COPIES, copiesNeeded);
        if (newCopyCount !== this.copyCount) {
          this.copyCount = newCopyCount;
          this.updateCopies();
        }
      }
    } else if (sequenceWidth > 0) {
      this.seqWidth = Math.ceil(sequenceWidth);
      const copiesNeeded = Math.ceil(containerWidth / sequenceWidth) + this.COPY_HEADROOM;
      const newCopyCount = Math.max(this.MIN_COPIES, copiesNeeded);
      if (newCopyCount !== this.copyCount) {
        this.copyCount = newCopyCount;
        this.updateCopies();
      }
    }
  }
  
  startAnimation() {
    const isVertical = this.direction === 'up' || this.direction === 'down';
    
    // Calculate target velocity
    const magnitude = Math.abs(this.speed);
    let directionMultiplier;
    if (isVertical) {
      directionMultiplier = this.direction === 'up' ? 1 : -1;
    } else {
      directionMultiplier = this.direction === 'left' ? 1 : -1;
    }
    const speedMultiplier = this.speed < 0 ? -1 : 1;
    const targetVelocity = magnitude * directionMultiplier * speedMultiplier;
    
    const animate = (timestamp) => {
      if (this.lastTimestamp === null) {
        this.lastTimestamp = timestamp;
      }
      
      const deltaTime = Math.max(0, timestamp - this.lastTimestamp) / 1000;
      this.lastTimestamp = timestamp;
      
      // Determine target speed based on hover state
      let target = targetVelocity;
      if (this.isHovered) {
        if (this.hoverSpeed !== undefined) {
          target = this.hoverSpeed;
        } else if (this.pauseOnHover === true) {
          target = 0;
        }
      }
      
      // Smooth velocity transition
      const easingFactor = 1 - Math.exp(-deltaTime / this.SMOOTH_TAU);
      this.velocity += (target - this.velocity) * easingFactor;
      
      // Update position
      const seqSize = isVertical ? this.seqHeight : this.seqWidth;
      if (seqSize > 0) {
        let nextOffset = this.offset + this.velocity * deltaTime;
        nextOffset = ((nextOffset % seqSize) + seqSize) % seqSize;
        this.offset = nextOffset;
        
        const transformValue = isVertical
          ? `translate3d(0, ${-this.offset}px, 0)`
          : `translate3d(${-this.offset}px, 0, 0)`;
        this.trackElement.style.transform = transformValue;
      }
      
      this.rafRef = requestAnimationFrame(animate);
    };
    
    this.rafRef = requestAnimationFrame(animate);
  }
  
  destroy() {
    if (this.rafRef !== null) {
      cancelAnimationFrame(this.rafRef);
      this.rafRef = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LogoLoop;
}
