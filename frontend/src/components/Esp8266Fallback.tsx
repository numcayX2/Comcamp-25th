import React from 'react';

interface Esp8266FallbackProps {
  className?: string;
  activeHotspot?: string | null;
  onSelectHotspot?: (id: string) => void;
}

export const Esp8266Fallback: React.FC<Esp8266FallbackProps> = ({
  className = '',
  activeHotspot = null,
  onSelectHotspot,
}) => {
  return (
    <div className={`relative w-full aspect-[16/10] max-w-xl mx-auto flex items-center justify-center p-4 ${className}`}>
      {/* Blueprint grid background container */}
      <div className="absolute inset-0 border border-[#D8D8D2] bg-[#F2F2EE]/60 rounded-xl overflow-hidden backdrop-blur-xs">
        <div className="absolute inset-0 bg-blueprint-grid opacity-30" />
        
        {/* Engineering header watermark */}
        <div className="absolute top-2.5 left-3 flex items-center gap-2 text-[10px] font-mono tracking-wider text-[#5A5D66]">
          <span className="inline-block w-1.5 h-1.5 bg-[#337AFF] rounded-full animate-pulse" />
          <span>SPEC_CAD // ESP8266_NODEMCU_V3_SCHEMATIC</span>
        </div>
        <div className="absolute top-2.5 right-3 text-[10px] font-mono text-[#5A5D66]">
          SCALE 1:1 // 2.4GHz IoT NODE
        </div>
      </div>

      {/* High precision SVG Schematic */}
      <svg
        viewBox="0 0 600 360"
        className="w-full h-full relative z-10 filter drop-shadow-md select-none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="pcbGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#14181B" />
            <stop offset="100%" stopColor="#0B0D0F" />
          </linearGradient>
          <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#B0B5B9" />
            <stop offset="50%" stopColor="#E2E4E6" />
            <stop offset="100%" stopColor="#8F9498" />
          </linearGradient>
          <linearGradient id="goldGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FFD269" />
            <stop offset="100%" stopColor="#D4991E" />
          </linearGradient>
          <filter id="glowBlue" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Outer dimensions & corner ticks */}
        <g stroke="#337AFF" strokeWidth="0.8" opacity="0.4">
          <line x1="85" y1="50" x2="105" y2="50" />
          <line x1="85" y1="50" x2="85" y2="70" />
          <line x1="515" y1="50" x2="495" y2="50" />
          <line x1="515" y1="50" x2="515" y2="70" />
          <line x1="85" y1="310" x2="105" y2="310" />
          <line x1="85" y1="310" x2="85" y2="290" />
          <line x1="515" y1="310" x2="495" y2="310" />
          <line x1="515" y1="310" x2="515" y2="290" />
        </g>

        {/* NodeMCU PCB Body */}
        <rect
          x="100"
          y="65"
          width="400"
          height="230"
          rx="12"
          fill="url(#pcbGrad)"
          stroke="#2A3036"
          strokeWidth="2.5"
        />

        {/* Mounting Holes */}
        <circle cx="120" cy="85" r="7" fill="#F2F2EE" stroke="#4A525A" strokeWidth="1.5" />
        <circle cx="480" cy="85" r="7" fill="#F2F2EE" stroke="#4A525A" strokeWidth="1.5" />
        <circle cx="120" cy="275" r="7" fill="#F2F2EE" stroke="#4A525A" strokeWidth="1.5" />
        <circle cx="480" cy="275" r="7" fill="#F2F2EE" stroke="#4A525A" strokeWidth="1.5" />

        {/* Solder Trace Patterns (Cyan/Tech Blue Subtle Lines) */}
        <g stroke="#337AFF" strokeWidth="1" opacity="0.3" fill="none">
          <path d="M 170 180 H 220 L 250 150 V 105" />
          <path d="M 180 200 H 230 L 260 230 H 310" />
          <path d="M 330 115 V 135 L 360 165 H 430" />
          <path d="M 280 260 V 240 L 310 210 H 420" />
        </g>

        {/* Micro-USB Port on Left */}
        <rect x="86" y="152" width="28" height="56" rx="4" fill="#9BA1A6" stroke="#4A5056" strokeWidth="1.5" />
        <rect x="82" y="162" width="10" height="36" rx="2" fill="#24282D" />

        {/* CP2102 USB-to-UART Bridge Chip */}
        <rect x="150" y="162" width="36" height="36" rx="2" fill="#1C2024" stroke="#4A525A" strokeWidth="1.2" />
        <circle cx="158" cy="170" r="2" fill="#5F6368" />
        <text x="168" y="183" fill="#80868B" fontSize="7" fontFamily="monospace" textAnchor="middle">CP2102</text>

        {/* Top GPIO Header Pins (15 pins) */}
        {Array.from({ length: 15 }).map((_, i) => (
          <g key={`top-pin-${i}`}>
            <rect x={145 + i * 22} y="72" width="12" height="12" rx="1.5" fill="#1F2328" stroke="#3A4048" />
            <circle cx={151 + i * 22} cy="78" r="3.2" fill="url(#goldGrad)" stroke="#B8860B" strokeWidth="0.8" />
          </g>
        ))}

        {/* Bottom GPIO Header Pins (15 pins) */}
        {Array.from({ length: 15 }).map((_, i) => (
          <g key={`bottom-pin-${i}`}>
            <rect x={145 + i * 22} y="276" width="12" height="12" rx="1.5" fill="#1F2328" stroke="#3A4048" />
            <circle cx={151 + i * 22} cy="282" r="3.2" fill="url(#goldGrad)" stroke="#B8860B" strokeWidth="0.8" />
          </g>
        ))}

        {/* ESP-12E Metal Shield Module */}
        <rect
          x="260"
          y="110"
          width="135"
          height="140"
          rx="6"
          fill="url(#shieldGrad)"
          stroke="#686F76"
          strokeWidth="1.5"
        />

        {/* RF Shield Markings */}
        <text x="327" y="145" fill="#202124" fontSize="13" fontFamily="Space Grotesk, sans-serif" fontWeight="700" textAnchor="middle">
          ESP-12E
        </text>
        <text x="327" y="165" fill="#3C4043" fontSize="9" fontFamily="monospace" textAnchor="middle">
          ESP8266MOD
        </text>
        <text x="327" y="182" fill="#5F6368" fontSize="7.5" fontFamily="monospace" textAnchor="middle">
          ISM 2.4GHz / PA +25dBm
        </text>
        <text x="327" y="196" fill="#5F6368" fontSize="7" fontFamily="monospace" textAnchor="middle">
          802.11 b/g/n Wi-Fi
        </text>

        {/* 2.4GHz Inverted-F Meander Antenna (PCB Area on right) */}
        <rect x="408" y="120" width="58" height="120" rx="3" fill="#171B1F" stroke="#363C44" />
        <path
          d="M 416 135 H 455 V 148 H 425 V 162 H 455 V 176 H 425 V 190 H 455 V 204 H 425 V 218 H 455"
          fill="none"
          stroke="url(#goldGrad)"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Blue Power / Status LED */}
        <circle cx="230" cy="130" r="3.5" fill="#337AFF" filter="url(#glowBlue)" />
        <circle cx="230" cy="130" r="1.8" fill="#E8F0FE" />
        <text x="220" y="122" fill="#337AFF" fontSize="7" fontFamily="monospace">PWR_LED</text>

        {/* HOTSPOT 1: [MCU // ESP8266EX 32-BIT] */}
        <g
          className="cursor-pointer group"
          onClick={() => onSelectHotspot && onSelectHotspot('mcu')}
        >
          <circle
            cx="327"
            cy="170"
            r={activeHotspot === 'mcu' ? "8" : "6"}
            fill="#337AFF"
            className="transition-all duration-300"
          />
          <circle cx="327" cy="170" r="12" fill="none" stroke="#337AFF" strokeWidth="1.2" strokeDasharray="3,3" className="animate-spin origin-[327px_170px]" />
          {/* Leader line to Top Tag */}
          <path d="M 327 158 V 35 H 250" fill="none" stroke="#337AFF" strokeWidth="1.5" strokeDasharray="4,3" />
          <circle cx="250" cy="35" r="2.5" fill="#337AFF" />
        </g>

        {/* HOTSPOT 2: [GPIO // 17 DIGITAL PINS] */}
        <g
          className="cursor-pointer group"
          onClick={() => onSelectHotspot && onSelectHotspot('gpio')}
        >
          <circle
            cx="240"
            cy="282"
            r={activeHotspot === 'gpio' ? "8" : "6"}
            fill="#337AFF"
            className="transition-all duration-300"
          />
          <circle cx="240" cy="282" r="12" fill="none" stroke="#337AFF" strokeWidth="1.2" strokeDasharray="3,3" />
          {/* Leader line to Bottom Tag */}
          <path d="M 240 295 V 335 H 150" fill="none" stroke="#337AFF" strokeWidth="1.5" strokeDasharray="4,3" />
          <circle cx="150" cy="335" r="2.5" fill="#337AFF" />
        </g>

        {/* HOTSPOT 3: [RF // 2.4GHZ WIFI SOC] */}
        <g
          className="cursor-pointer group"
          onClick={() => onSelectHotspot && onSelectHotspot('rf')}
        >
          <circle
            cx="435"
            cy="176"
            r={activeHotspot === 'rf' ? "8" : "6"}
            fill="#337AFF"
            className="transition-all duration-300"
          />
          <circle cx="435" cy="176" r="12" fill="none" stroke="#337AFF" strokeWidth="1.2" strokeDasharray="3,3" />
          {/* Leader line to Top Right Tag */}
          <path d="M 435 160 V 35 H 520" fill="none" stroke="#337AFF" strokeWidth="1.5" strokeDasharray="4,3" />
          <circle cx="520" cy="35" r="2.5" fill="#337AFF" />
        </g>

        {/* HOTSPOT 4: [PWR // 3.3V LOGIC LEVEL] */}
        <g
          className="cursor-pointer group"
          onClick={() => onSelectHotspot && onSelectHotspot('pwr')}
        >
          <circle
            cx="100"
            cy="180"
            r={activeHotspot === 'pwr' ? "8" : "6"}
            fill="#337AFF"
            className="transition-all duration-300"
          />
          <circle cx="100" cy="180" r="12" fill="none" stroke="#337AFF" strokeWidth="1.2" strokeDasharray="3,3" />
          {/* Leader line to Left Tag */}
          <path d="M 88 180 H 30 V 220" fill="none" stroke="#337AFF" strokeWidth="1.5" strokeDasharray="4,3" />
          <circle cx="30" cy="220" r="2.5" fill="#337AFF" />
        </g>
      </svg>

      {/* Floating Hotspot Badges (HTML Overlay with Swiss Tech Border) */}
      <button
        onClick={() => onSelectHotspot && onSelectHotspot('mcu')}
        className={`absolute top-2 left-10 md:left-24 px-2.5 py-1 text-[11px] font-mono border rounded transition-all duration-200 z-20 cursor-pointer ${
          activeHotspot === 'mcu'
            ? 'bg-[#337AFF] text-white border-[#337AFF] shadow-sm shadow-[#337AFF]/30 font-semibold'
            : 'bg-[#FFFFFC] text-[#111215] border-[#337AFF]/60 hover:bg-[#F2F2EE]'
        }`}
      >
        [MCU // ESP8266EX 32-BIT]
      </button>

      <button
        onClick={() => onSelectHotspot && onSelectHotspot('rf')}
        className={`absolute top-2 right-4 md:right-16 px-2.5 py-1 text-[11px] font-mono border rounded transition-all duration-200 z-20 cursor-pointer ${
          activeHotspot === 'rf'
            ? 'bg-[#337AFF] text-white border-[#337AFF] shadow-sm shadow-[#337AFF]/30 font-semibold'
            : 'bg-[#FFFFFC] text-[#111215] border-[#337AFF]/60 hover:bg-[#F2F2EE]'
        }`}
      >
        [RF // 2.4GHZ WIFI SOC]
      </button>

      <button
        onClick={() => onSelectHotspot && onSelectHotspot('gpio')}
        className={`absolute bottom-2 left-8 md:left-20 px-2.5 py-1 text-[11px] font-mono border rounded transition-all duration-200 z-20 cursor-pointer ${
          activeHotspot === 'gpio'
            ? 'bg-[#337AFF] text-white border-[#337AFF] shadow-sm shadow-[#337AFF]/30 font-semibold'
            : 'bg-[#FFFFFC] text-[#111215] border-[#337AFF]/60 hover:bg-[#F2F2EE]'
        }`}
      >
        [GPIO // 17 DIGITAL PINS]
      </button>

      <button
        onClick={() => onSelectHotspot && onSelectHotspot('pwr')}
        className={`absolute bottom-6 right-8 md:right-24 px-2.5 py-1 text-[11px] font-mono border rounded transition-all duration-200 z-20 cursor-pointer ${
          activeHotspot === 'pwr'
            ? 'bg-[#337AFF] text-white border-[#337AFF] shadow-sm shadow-[#337AFF]/30 font-semibold'
            : 'bg-[#FFFFFC] text-[#111215] border-[#337AFF]/60 hover:bg-[#F2F2EE]'
        }`}
      >
        [PWR // 3.3V LOGIC LEVEL]
      </button>
    </div>
  );
};
