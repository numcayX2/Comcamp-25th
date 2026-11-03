import React, { useState, useEffect, Suspense, startTransition } from 'react';

// Dynamic lazy import of 3D Stage deferred until browser idle / user interaction
const Rev25Stage3D = React.lazy(() =>
  import('./Rev25Stage3D').then((m) => ({ default: m.Rev25Stage3D }))
);

// Lightweight Swiss CAD Blueprint SVG Schematic Fallback (0ms paint, zero network lag)
const SwissBlueprintFallback: React.FC<{ activeSection: string; isDark: boolean }> = ({
  activeSection,
  isDark,
}) => {
  return (
    <div className="fixed inset-0 pointer-events-none z-10 overflow-hidden" aria-hidden="true">
      <svg className="w-full h-full" aria-hidden="true">
        {activeSection === 'hero' && (
          <g className="transition-opacity duration-300">
            {/* Desktop Arduino UNO R3 CAD Schematic Outline */}
            <g className="hidden lg:block" transform="translate(940, 250)">
              <rect
                x="-140"
                y="-100"
                width="280"
                height="200"
                rx="4"
                fill={isDark ? '#0c1520' : '#f0fdf4'}
                stroke="#337AFF"
                strokeWidth="1.5"
                strokeDasharray="6 3"
              />
              <rect x="-155" y="-70" width="25" height="40" rx="2" fill="none" stroke="#337AFF" strokeWidth="1.5" />
              <text x="-135" y="-76" className="font-mono text-[9px] fill-[#337AFF]">USB-B</text>
              <rect x="-30" y="-15" width="110" height="30" rx="2" fill="none" stroke="var(--rm-hairline-strong)" strokeWidth="1.5" />
              <text x="25" y="5" textAnchor="middle" className="font-mono text-[10px] fill-[var(--rm-text-muted)]">ATMEGA328P · 16MHz</text>
              <line x1="-100" y1="-88" x2="120" y2="-88" stroke="#337AFF" strokeWidth="2" strokeDasharray="3 4" />
              <text x="10" y="-96" textAnchor="middle" className="font-mono text-[9px] fill-[#337AFF]">DIGITAL I/O (D0–D13 · PWM)</text>
              <line x1="-80" y1="88" x2="100" y2="88" stroke="var(--rm-hairline-strong)" strokeWidth="2" strokeDasharray="3 4" />
              <text x="10" y="80" textAnchor="middle" className="font-mono text-[9px] fill-[var(--rm-text-muted)]">POWER 5V/GND · ANALOG A0–A5</text>
              <line x1="-140" y1="-118" x2="140" y2="-118" stroke="var(--rm-hairline-strong)" strokeWidth="1" />
              <line x1="-140" y1="-124" x2="-140" y2="-112" stroke="var(--rm-hairline-strong)" strokeWidth="1" />
              <line x1="140" y1="-124" x2="140" y2="-112" stroke="var(--rm-hairline-strong)" strokeWidth="1" />
              <text x="0" y="-126" textAnchor="middle" className="font-mono text-[10px] fill-[var(--rm-text-subtle)]">68.6 mm (LENGTH)</text>
            </g>

            {/* Desktop ESP8266 CAD Schematic Outline */}
            <g className="hidden lg:block" transform="translate(1080, 520)">
              <rect
                x="-80"
                y="-45"
                width="160"
                height="90"
                rx="3"
                fill={isDark ? '#0f172a' : '#f8fafc'}
                stroke="#00B4D8"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />
              <rect x="-40" y="-35" width="65" height="55" rx="2" fill="none" stroke="#00B4D8" strokeWidth="1" />
              <text x="-8" y="-3" textAnchor="middle" className="font-mono text-[9px] fill-[#00B4D8]">ESP-12E · 32-BIT</text>
              <path d="M -75 -25 L -65 -25 L -65 -15 L -75 -15 L -75 -5 L -65 -5" fill="none" stroke="#F59E0B" strokeWidth="1.5" />
              <text x="-70" y="25" textAnchor="middle" className="font-mono text-[8px] fill-[#F59E0B]">2.4GHz</text>
              <rect x="75" y="-15" width="12" height="30" rx="1" fill="none" stroke="var(--rm-hairline-strong)" strokeWidth="1" />
            </g>
          </g>
        )}
      </svg>
    </div>
  );
};

// 7 Hotspot Data for Arduino UNO R3
const UNO_HOTSPOTS = [
  {
    code: '01',
    label: 'USB-B',
    title: 'พอร์ตอัปโหลดโค้ดและสื่อสาร Serial Monitor',
    desc: 'ท่อลำเลียงโค้ดภาษา C/C++ จากคอมพิวเตอร์ลงสู่บอร์ด พร้อมใช้ส่งข้อความโต้ตอบกับบอร์ดแบบเรียลไทม์ผ่านหน้าต่าง Serial Monitor¹',
    tag: '5V POWER & UART',
  },
  {
    code: '02',
    label: 'ATMEGA328P',
    title: 'สมองกลไมโครคอนโทรลเลอร์ 8-bit',
    desc: 'หัวใจหลักที่รันคำสั่งตั้งค่าใน setup() แล้ววนลูปทำงานใน loop() ด้วยจังหวะสัญญาณนาฬิกา 16 ล้านครั้งต่อวินาที (16 MHz)',
    tag: '8-BIT AVR RISC',
  },
  {
    code: '03',
    label: 'DIGITAL 0–13',
    title: 'ขาสัญญาณตรรกะดิจิทัล 14 ช่อง',
    desc: 'ขาสัญญาณพื้นฐานที่สุดของโลกคอมพิวเตอร์ ทำหน้าที่รับและส่งสถานะ HIGH (5V / 1) หรือ LOW (0V / 0) เพื่อสั่งงานวงจร',
    tag: 'LOGIC 0 / 1 · 5V',
  },
  {
    code: '04',
    label: '~PWM (3,5,6,9,10,11)',
    title: 'ขาสัญญาณพัลส์จำลองระดับพลังงาน',
    desc: 'ขาสัญญาณที่มีเครื่องหมายตัวหนอน (~) ใช้เทคนิคสับสวิตช์ความถี่สูง² เพื่อหรี่แสงไฟ LED หรือปรับความเร็วมอเตอร์อย่างละเอียด',
    tag: 'PULSE WIDTH MODULATION',
  },
  {
    code: '05',
    label: 'ANALOG IN A0–A5',
    title: 'ขารับค่าอนาล็อกจากเซนเซอร์โลกจริง',
    desc: 'วงจรแปลงสัญญาณแรงดันไฟฟ้าจากเซนเซอร์วัดแสงหรืออุณหภูมิ ให้กลายเป็นค่าตัวเลขดิจิทัล 10-bit ตั้งแต่ 0 ถึง 1023',
    tag: '10-BIT ADC (0–1023)',
  },
  {
    code: '06',
    label: 'POWER 5V / 3.3V / GND',
    title: 'รางจ่ายไฟเลี้ยงและจุดอ้างอิงกราวด์',
    desc: 'ฝึกพื้นฐานการเดินระบบไฟเลี้ยงวงจร (VCC) และการต่อกราวด์ร่วม (Common GND) อย่างถูกต้องตามหลักวิศวกรรมฮาร์ดแวร์',
    tag: 'VCC / GND RAILS',
  },
  {
    code: '07',
    label: 'LED "L" (PIN D13)',
    title: 'Blink #1 โปรแกรมแรกในชีวิตการเขียนโค้ด',
    desc: 'หลอดไฟประจำขา D13 ที่น้องจะได้เขียนคำสั่ง digitalWrite() สั่งให้กระพริบเป็นจังหวะแรกในค่ายผ่านสายสัญญาณ',
    tag: 'BLINK #01 · WIRED',
  },
];

// 7 Hotspot Data for ESP8266 NodeMCU
const ESP_HOTSPOTS = [
  {
    code: '01',
    label: 'ESP-12E RF MODULE',
    title: 'โมดูลประมวลผล 32-bit พร้อมภาคส่งคลื่นวิทยุ',
    desc: 'ชิปประมวลผลสถาปัตยกรรม 32-bit ความเร็ว 80 MHz ผสานวงจรสื่อสารไร้สาย Wi-Fi ภายใต้ฝาครอบโลหะกันสัญญาณรบกวน',
    tag: '32-BIT RISC · 80MHz',
  },
  {
    code: '02',
    label: 'PCB ANTENNA',
    title: 'เสาอากาศลายทองแดง 2.4 GHz บนแผ่นวงจร',
    desc: 'ลายทองแดงพับซิกแซกที่ออกแบบตามความยาวคลื่น ทำหน้าที่รับ-ส่งแพ็กเกจข้อมูลไร้สายมาตรฐาน IEEE 802.11 b/g/n',
    tag: '802.11 b/g/n · 2.4 GHz',
  },
  {
    code: '03',
    label: 'MICRO-USB + UART',
    title: 'พอร์ตโปรแกรมและชิปบริดจ์สื่อสารความเร็วสูง',
    desc: 'เชื่อมต่อคอมพิวเตอร์เพื่ออัปโหลดโค้ดจาก Arduino IDE ตัวเดิมที่คุ้นเคยจากบอร์ดแรก แต่เปลี่ยนเป้าหมายสู่โหนดไร้สาย',
    tag: 'UART TO USB BRIDGE',
  },
  {
    code: '04',
    label: 'GPIO D0–D8',
    title: 'ขาสัญญาณอเนกประสงค์ระดับแรงดัน 3.3V',
    desc: 'ขาควบคุมอินพุตและเอาต์พุต¹ ที่ทำงานบนตรรกะแรงดัน 3.3V ซึ่งเป็นมาตรฐานของชิปประมวลผลยุคใหม่และอุปกรณ์ IoT',
    tag: 'GPIO · 3.3V LOGIC',
  },
  {
    code: '05',
    label: 'ANALOG PIN A0',
    title: 'ขารับสัญญาณอนาล็อกช่องเดียวของบอร์ด',
    desc: 'ฝึกวิธีคิดเชิงวิศวกรรมในการบริหารทรัพยากรฮาร์ดแวร์ที่มีจำกัด และการออกแบบวงจรแบ่งแรงดันให้เหมาะกับชิป 3.3V',
    tag: '1-CH 10-BIT ADC',
  },
  {
    code: '06',
    label: 'FLASH / RST KEYS',
    title: 'ปุ่มกดฮาร์ดแวร์สำหรับรีเซ็ตและแฟลชเฟิร์มแวร์',
    desc: 'สวิตช์แบบ Tactile บนบอร์ดสำหรับสั่งรีบูตระบบทันที (RST) หรือบังคับเข้าโหมดเขียนทับเฟิร์มแวร์ระดับล่าง (FLASH)',
    tag: 'HARDWARE INTERRUPTS',
  },
  {
    code: '07',
    label: 'ONBOARD LED',
    title: 'Blink #2 สั่งไฟกระพริบข้ามอากาศผ่าน Wi-Fi',
    desc: 'หลอดไฟดวงเล็กที่คราวนี้ไม่ต้องพึ่งสายคำสั่งจากคอมพิวเตอร์ แต่กดสั่งเปิด-ปิดได้โดยตรงจากหน้าเว็บและสมาร์ทโฟน',
    tag: 'BLINK #02 · WIRELESS',
  },
];

// Datasheet Table Rows
const DATASHEET_ROWS = [
  { id: 'mcu', label: 'MCU ARCHITECTURE', uno: 'ATmega328P (8-bit AVR)', esp: 'Tensilica L106 (32-bit RISC)' },
  { id: 'clock', label: 'CLOCK SPEED', uno: '16 MHz', esp: '80 MHz (Up to 160 MHz)' },
  { id: 'voltage', label: 'OPERATING LOGIC', uno: '5.0 V', esp: '3.3 V' },
  { id: 'gpio', label: 'DIGITAL I/O', uno: '14 Pins (6 PWM)', esp: 'GPIO D0–D8 (PWM Supported)' },
  { id: 'analog', label: 'ANALOG INPUT', uno: '6 Channels (A0–A5, 10-bit)', esp: '1 Channel (A0, 10-bit)' },
  { id: 'flash', label: 'FLASH MEMORY', uno: '32 KB (0.5 KB Bootloader)', esp: '4 MB (External SPI Flash)' },
  { id: 'conn', label: 'CONNECTIVITY', uno: 'USB-B Serial (Wired)', esp: 'Wi-Fi 802.11 b/g/n 2.4 GHz' },
  { id: 'dims', label: 'FORM FACTOR', uno: '68.6 × 53.4 mm', esp: '~49.0 × 26.0 mm (NodeMCU)' },
];

// Signal Chain Foundation Nodes
const SIGNAL_NODES = [
  {
    step: '01',
    phase: 'INPUT',
    camp: 'อ่านค่าแสงและสภาพแวดล้อมผ่านขา A0 [UNO R3]',
    cs: 'การรับข้อมูลและการแปลงสัญญาณดิจิทัล (Data & Signals)',
  },
  {
    step: '02',
    phase: 'LOGIC',
    camp: 'เขียนเงื่อนไข if / else และวนลูป loop() ตัดสินใจ [UNO R3]',
    cs: 'โครงสร้างการเขียนโปรแกรมและอัลกอริทึม (Programming & Algorithms)',
  },
  {
    step: '03',
    phase: 'OUTPUT',
    camp: 'สั่งเปิด-ปิดไฟ LED และควบคุมจังหวะพัลส์ ~PWM [UNO R3]',
    cs: 'สถาปัตยกรรมคอมพิวเตอร์และระบบฝังตัว (Computer Systems)',
  },
  {
    step: '04',
    phase: 'NETWORK',
    camp: 'เชื่อมต่อคลื่น 2.4 GHz และรับ-ส่งแพ็กเกจไร้สาย [ESP8266]',
    cs: 'เครือข่ายคอมพิวเตอร์และโปรโตคอลสื่อสาร (Computer Networks)',
  },
  {
    step: '05',
    phase: 'SYSTEM',
    camp: 'สั่งงานฮาร์ดแวร์จริงจากหน้าเว็บและมือถือแบบครบวงจร [ESP8266]',
    cs: 'วิศวกรรมซอฟต์แวร์และระบบอัจฉริยะ (Software Engineering & IoT)',
  },
];

// Compatibility A0-A5 Pin Header with Interactive Telemetry Readout
const COMPATIBILITY_PINS = [
  {
    pin: 'A0',
    level: 'ม.4',
    desc: 'มัธยมศึกษาปีที่ 4 (ทุกแผนการเรียน)',
    adc: '1023',
    voltage: '5.00V',
    note: 'เหมาะสำหรับน้อง ม.4 ที่อยากค้นหาตัวเองแต่เนิ่นๆ ไม่ต้องมีพื้นฐานมาก่อนก็เริ่มเขียนโค้ดบรรทัดแรกไปพร้อมพี่ๆ ได้ทันที',
  },
  {
    pin: 'A1',
    level: 'ม.5',
    desc: 'มัธยมศึกษาปีที่ 5 (ทุกแผนการเรียน)',
    adc: '1023',
    voltage: '5.00V',
    note: 'จังหวะสำคัญในการเก็บพอร์ตโฟลิโอและทดลองลงมือทำจริง เพื่อพิสูจน์ว่าตนเองชอบสายวิทยาการคอมพิวเตอร์หรือไม่',
  },
  {
    pin: 'A2',
    level: 'ม.6',
    desc: 'มัธยมศึกษาปีที่ 6 (ทุกแผนการเรียน)',
    adc: '1023',
    voltage: '5.00V',
    note: 'เตรียมความพร้อมก่อนก้าวเข้าสู่รั้วมหาวิทยาลัย สัมผัสบรรยากาศการเรียนและห้องปฏิบัติการจริงของวิทยาการคอมพิวเตอร์ ม.แม่โจ้',
  },
  {
    pin: 'A3',
    level: 'ปวช.1',
    desc: 'ประกาศนียบัตรวิชาชีพ ชั้นปีที่ 1',
    adc: '1023',
    voltage: '5.00V',
    note: 'เปิดรับน้องสายอาชีวะทุกสาขาที่สนใจการเขียนโปรแกรมและการต่อวงจรไมโครคอนโทรลเลอร์ ปูรากฐานสู่สายนักพัฒนา',
  },
  {
    pin: 'A4',
    level: 'ปวช.2',
    desc: 'ประกาศนียบัตรวิชาชีพ ชั้นปีที่ 2',
    adc: '1023',
    voltage: '5.00V',
    note: 'ต่อยอดทักษะปฏิบัติที่ถนัดอยู่แล้ว ให้เชื่อมโยงเข้ากับหลักคิดเชิงอัลกอริทึมและเครือข่ายไร้สาย IoT',
  },
  {
    pin: 'A5',
    level: 'ปวช.3',
    desc: 'ประกาศนียบัตรวิชาชีพ ชั้นปีที่ 3',
    adc: '1023',
    voltage: '5.00V',
    note: 'เชื่อมต่อเส้นทางศึกษาต่อระดับปริญญาตรี สาขาวิชาวิทยาการคอมพิวเตอร์ ด้วยพื้นฐานทั้งซอฟต์แวร์และฮาร์ดแวร์ที่แข็งแกร่ง',
  },
];

export const MainLandingPage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<string>('hero');
  const [scrollProgress, setScrollProgress] = useState<number>(0);
  const [unoHotspotIndex, setUnoHotspotIndex] = useState<number>(0);
  const [espHotspotIndex, setEspHotspotIndex] = useState<number>(0);
  const [specHoveredRow, setSpecHoveredRow] = useState<string | null>(null);
  const [primaryCtaHovered, setPrimaryCtaHovered] = useState<boolean>(false);
  const [secondaryCtaHovered, setSecondaryCtaHovered] = useState<boolean>(false);
  const [unoWiredLedToggled, setUnoWiredLedToggled] = useState<boolean>(false);
  const [wifiLedToggled, setWifiLedToggled] = useState<boolean>(false);
  const [selectedAnalogPin, setSelectedAnalogPin] = useState<number>(0);
  const [isDark, setIsDark] = useState<boolean>(false);

  const [isBooting, setIsBooting] = useState<boolean>(false);
  const [bootLines, setBootLines] = useState<string[]>([]);

  // Defer heavy WebGL stage until idle or first user interaction to eliminate TBT blocking
  const [is3DReady, setIs3DReady] = useState<boolean>(false);

  useEffect(() => {
    let activated = false;
    const activate3D = () => {
      if (activated) return;
      activated = true;
      startTransition(() => {
        setIs3DReady(true);
      });
    };

    const onUserInteract = () => activate3D();
    window.addEventListener('scroll', onUserInteract, { passive: true, once: true });
    window.addEventListener('pointermove', onUserInteract, { passive: true, once: true });
    window.addEventListener('touchstart', onUserInteract, { passive: true, once: true });

    // Fallback activation after initial paint & Lighthouse quiet window
    const timer = setTimeout(() => {
      if ('requestIdleCallback' in window) {
        (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(activate3D);
      } else {
        activate3D();
      }
    }, 1400);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', onUserInteract);
      window.removeEventListener('pointermove', onUserInteract);
      window.removeEventListener('touchstart', onUserInteract);
    };
  }, []);

  const runHardwareDiagnostic = () => {
    setBootLines([]);
    setIsBooting(true);
    const seq = [
      '> CC25-RM boot · REV.25',
      '> Serial.begin(9600)',
      '> ARDUINO UNO R3 .......... OK',
      '> ESP8266 NODEMCU ......... OK',
    ];
    seq.forEach((line, idx) => {
      setTimeout(() => {
        setBootLines((prev) => [...prev, line]);
      }, idx * 220);
    });
    setTimeout(() => {
      setIsBooting(false);
    }, 2800);
  };

  useEffect(() => {
    console.log(
      '%cสวัสดีนักพัฒนา ถ้าคุณเปิด Console อยู่ แปลว่าคุณมาถูกค่ายแล้ว -> /register',
      'background: #06070A; color: #00E575; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 2px;'
    );

    const hasDark =
      document.documentElement.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme') === 'dark';
    setIsDark(hasDark);

    try {
      const hasBooted = sessionStorage.getItem('cc25_rm_booted');
      if (!hasBooted) {
        setIsBooting(true);
        const seq = [
          '> CC25-RM boot · REV.25',
          '> Serial.begin(9600)',
          '> ARDUINO UNO R3 .......... OK',
          '> ESP8266 NODEMCU ......... OK',
        ];
        seq.forEach((line, idx) => {
          setTimeout(() => {
            setBootLines((prev) => [...prev, line]);
          }, idx * 240);
        });

        const dismissTimer = setTimeout(() => {
          setIsBooting(false);
          sessionStorage.setItem('cc25_rm_booted', 'true');
        }, 1200);

        return () => clearTimeout(dismissTimer);
      }
    } catch {}
  }, []);

  const dismissBoot = () => {
    setIsBooting(false);
    try {
      sessionStorage.setItem('cc25_rm_booted', 'true');
    } catch {}
  };

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? Math.min(1, Math.max(0, scrollY / docHeight)) : 0;
      setScrollProgress(progress);

      const sections = [
        { id: 'overview', name: 'hero' },
        { id: 'thesis', name: 'thesis' },
        { id: 'board-uno', name: 'board-uno' },
        { id: 'bridge', name: 'bridge' },
        { id: 'board-esp', name: 'board-esp' },
        { id: 'spec', name: 'spec' },
        { id: 'path', name: 'path' },
        { id: 'compatibility', name: 'compatibility' },
        { id: 'power-on', name: 'power-on' },
        { id: 'colophon', name: 'colophon' },
      ];

      if (docHeight > 0 && scrollY >= docHeight - 80) {
        setActiveSection('power-on');
        setScrollProgress(1);
        return;
      }

      for (let i = sections.length - 1; i >= 0; i--) {
        const el = document.getElementById(sections[i].id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= window.innerHeight * 0.45) {
            setActiveSection(sections[i].name);
            break;
          }
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const toggleTheme = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    if (newDark) {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
      try {
        localStorage.setItem('comcamp-theme', 'dark');
      } catch {}
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.setAttribute('data-theme', 'light');
      try {
        localStorage.setItem('comcamp-theme', 'light');
      } catch {}
    }
  };

  const getSectionLabel = () => {
    switch (activeSection) {
      case 'hero':
        return '01/09  REV.25 — OVERVIEW';
      case 'thesis':
        return '02/09  THESIS — THE TWO BLINKS';
      case 'board-uno':
        return '03/09  BOARD 01 — ARDUINO UNO R3';
      case 'bridge':
        return '04/09  SIGNAL BRIDGE — WIRE TO AIR';
      case 'board-esp':
        return '05/09  BOARD 02 — ESP8266 NODEMCU';
      case 'spec':
        return '06/09  SPEC SHEET — DATASHEET';
      case 'path':
        return '07/09  SIGNAL PATH — COMPUTER SCIENCE';
      case 'compatibility':
        return '08/09  COMPATIBILITY — ELIGIBILITY';
      case 'power-on':
        return '09/09  POWER ON — INITIALIZE';
      case 'colophon':
        return 'CC25-RM · END OF MANUAL';
      default:
        return '01/09  REV.25 — OVERVIEW';
    }
  };

  const activeEligibility = COMPATIBILITY_PINS[selectedAnalogPin] || COMPATIBILITY_PINS[0];

  return (
    <div className="relative min-h-screen w-full flex flex-col bg-[var(--rm-paper)] text-[var(--rm-ink)] selection:bg-[#337AFF] selection:text-white transition-colors duration-300">
      
      {/* SWISS HARDWARE SERIAL MONITOR HUD */}
      {isBooting && (
        <aside
          role="status"
          aria-live="polite"
          aria-label="Hardware Serial Monitor Diagnostics"
          className="fixed bottom-6 right-6 z-40 max-w-[320px] sm:max-w-[360px] w-[calc(100vw-3rem)] p-3.5 bg-[var(--rm-paper)]/95 dark:bg-[#06070A]/95 backdrop-blur-md border border-[var(--rm-hairline-strong)] rounded-[2px] shadow-2xl font-mono text-xs text-[var(--rm-ink)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--rm-hairline)] pb-2 mb-2 text-[10px] text-[var(--rm-text-subtle)] tracking-wider">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#03B800] animate-pulse" />
              <span className="font-semibold text-[var(--rm-ink)]">SERIAL MONITOR</span>
              <span>· 9600 BAUD</span>
            </div>
            <button
              onClick={dismissBoot}
              className="text-[11px] text-[var(--rm-text-muted)] hover:text-[var(--rm-ink)] px-3 py-2 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
              aria-label="Dismiss serial monitor"
            >
              [X CLOSE]
            </button>
          </div>
          <div className="space-y-1 font-mono text-[11px] leading-relaxed">
            {bootLines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="rm-text-green font-bold">&gt;</span>
                <span className={line.includes('OK') ? 'rm-text-green font-medium' : 'text-[var(--rm-text-muted)]'}>
                  {line.replace(/^>\s*/, '')}
                </span>
              </div>
            ))}
          </div>
        </aside>
      )}

      {/* 3D STAGE & SWISS CAD BLUEPRINT SCHEMATIC FALLBACK */}
      {is3DReady ? (
        <Suspense fallback={<SwissBlueprintFallback activeSection={activeSection} isDark={isDark} />}>
          <Rev25Stage3D
            activeSection={activeSection}
            scrollProgress={scrollProgress}
            unoHotspotIndex={unoHotspotIndex}
            espHotspotIndex={espHotspotIndex}
            specHoveredRow={specHoveredRow}
            primaryCtaHovered={primaryCtaHovered}
            secondaryCtaHovered={secondaryCtaHovered}
            unoWiredLedToggled={unoWiredLedToggled}
            wifiLedToggled={wifiLedToggled}
            isDark={isDark}
          />
        </Suspense>
      ) : (
        <SwissBlueprintFallback activeSection={activeSection} isDark={isDark} />
      )}

      {/* 00 · STATUS BAR (Sticky Nav · >= 44px Touch Targets & Non-Interactive 14-Pin Telemetry Bar) */}
      <header className="sticky top-0 z-40 w-full h-16 px-5 sm:px-10 xl:px-16 flex items-center justify-between border-b border-[var(--rm-hairline)] bg-[var(--rm-paper)]/95 backdrop-blur-md transition-colors pb-1">
        {/* Left: Brand Identity & Document Revision */}
        <div className="flex items-center gap-3">
          <a
            href="#overview"
            className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-[var(--rm-ink)] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors px-2 py-2 min-h-[44px]"
          >
            <span>CC25</span>
            <span className="text-[var(--rm-text-subtle)]">/</span>
            <span>CSMJU</span>
          </a>
          <span className="w-px h-3.5 bg-[var(--rm-hairline-strong)]" />
          <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium tracking-widest border border-[var(--rm-hairline-strong)] rounded-[2px] text-[var(--rm-text-muted)]">
            REV.25
          </span>
        </div>

        {/* Center: Live Monospace Section Indicator */}
        <div className="hidden md:flex items-center gap-2 font-mono text-xs tracking-wider text-[var(--rm-text-muted)] font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-[#03B800] animate-pulse" />
          <span>{getSectionLabel()}</span>
        </div>

        {/* Right: Slide Theme Switch, Status Link & Register CTA (Well-spaced >= 44x44px targets) */}
        <div className="flex items-center gap-3 sm:gap-4 font-mono text-xs">
          <button
            onClick={toggleTheme}
            className="flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] min-w-[44px] rounded-[2px] border border-[var(--rm-hairline-strong)] text-[11px] font-mono tracking-wider hover:bg-[var(--rm-surface)] transition-colors cursor-pointer"
            title="Toggle Light/Dark Theme"
          >
            <span className={isDark ? 'text-[var(--rm-text-muted)]' : 'rm-text-blue font-bold'}>LIGHT</span>
            <span className="text-[var(--rm-text-subtle)]">/</span>
            <span className={isDark ? 'rm-text-cyan font-bold' : 'text-[var(--rm-text-muted)]'}>DARK</span>
          </button>

          <a
            href="/status"
            data-astro-prefetch="false"
            className="hidden sm:inline-flex items-center justify-center px-3 py-2 min-h-[44px] min-w-[44px] tracking-wider text-[var(--rm-text-muted)] hover:text-[var(--rm-ink)] transition-colors"
          >
            STATUS
          </a>

          <a
            href="/register"
            data-astro-prefetch="false"
            className="flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-[2px] bg-[var(--rm-ink)] text-[var(--rm-paper)] font-medium tracking-wider hover:opacity-90 transition-opacity"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#03B800]" />
            <span>REGISTER -&gt;</span>
          </a>
        </div>

        {/* BOTTOM HAIRLINE: 14 Digital Pins (D0–D13) Passive Telemetry Indicator (Zero Touch-Target Collision) */}
        <div
          className="absolute bottom-0 left-0 right-0 h-[3px] flex items-center justify-between px-5 sm:px-10 xl:px-16 border-t border-[var(--rm-hairline)] bg-[var(--rm-paper)] pointer-events-none"
          aria-hidden="true"
        >
          {Array.from({ length: 14 }).map((_, i) => {
            const isLit = scrollProgress >= i / 14 || scrollProgress >= 0.92;
            const pinColor = i < 7 ? '#337AFF' : i < 12 ? '#00B4D8' : '#03B800';
            return (
              <div
                key={i}
                className="h-full flex-1 mx-[1px] transition-colors duration-150"
                style={{
                  backgroundColor: isLit ? pinColor : 'transparent',
                }}
              />
            );
          })}
        </div>
      </header>

      {/* MAIN DOCUMENT CONTAINER */}
      <main className="w-full flex flex-col flex-1">
        
        {/* ============================================================
            01 · HERO "REV.25"
            ============================================================ */}
        <section
          id="overview"
          className="relative w-full min-h-[calc(100vh-4rem)] flex flex-col justify-between pt-8 pb-10 border-b border-[var(--rm-hairline)]"
        >
          {/* Top Metadata Bar */}
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex items-center justify-between font-mono text-xs text-[var(--rm-text-muted)]">
            <div className="flex items-center gap-2.5">
              <span className="rm-crosshair" aria-hidden="true" />
              <span className="text-[var(--rm-ink)] font-semibold">CC25-RM</span>
              <span>/</span>
              <span>REV.25</span>
              <span>·</span>
              <span>REFERENCE SPECIFICATION</span>
            </div>
            <div className="hidden lg:flex items-center gap-3 text-[11px] text-[var(--rm-text-subtle)]">
              <span>ARDUINO UNO R3 (68.6 mm) + ESP8266 NODEMCU (49.0 mm)</span>
              <span className="rm-crosshair" aria-hidden="true" />
            </div>
          </div>

          {/* Hero Center Grid */}
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 grid grid-cols-1 lg:grid-cols-12 gap-8 my-auto items-center py-8">
            
            {/* Col 1–7: Typography & CTA */}
            <div className="lg:col-span-7 flex flex-col z-20">
              
              <div className="flex items-center gap-2 mb-4 font-silkscreen text-xs rm-text-blue font-semibold">
                <span className="w-2 h-2 rounded-[1px] bg-[#337AFF]" />
                <span>CSMJU HARDWARE WORKSHOP · DOCUMENT CC25-RM</span>
              </div>

              <h1 className="font-kanit font-medium text-4xl sm:text-5xl lg:text-[4.5rem] leading-[1.12] text-[var(--rm-ink)] mb-4">
                จากขาสัญญาณ <br className="hidden sm:inline" />
                สู่สัญญาณไร้สาย
              </h1>

              <p className="font-kanit text-sm sm:text-base text-[var(--rm-text-muted)] font-normal mb-4">
                ค่ายยุวชนคอมพิวเตอร์ ครั้งที่ 25 · สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้
              </p>

              <p className="font-kanit font-light text-base sm:text-xl lg:text-[21px] leading-relaxed text-[var(--rm-text-muted)] max-w-2xl mb-8">
                คู่มือปฏิบัติการฮาร์ดแวร์ฉบับลงมือทำจริง พาน้องเริ่มต้นเขียนโค้ดสั่งไฟ LED ดวงแรกผ่านสายทองแดงบน Arduino UNO R3
                ก่อนก้าวข้ามขีดจำกัดของสายไฟ ไปสั่งงานอุปกรณ์ชิ้นเดิมผ่านคลื่น Wi-Fi บน ESP8266
              </p>

              {/* Dual Sharp Instrument CTA Buttons */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 max-w-xl">
                <a
                  href="/register"
                  data-astro-prefetch="false"
                  onMouseEnter={() => setPrimaryCtaHovered(true)}
                  onMouseLeave={() => setPrimaryCtaHovered(false)}
                  className="rm-btn-sharp rm-btn-primary flex-1 flex items-center justify-between px-6 cursor-pointer group shadow-sm hover:shadow-md min-h-[56px] sm:min-h-[64px]"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-2 h-2 rounded-full transition-colors duration-200 ${
                        primaryCtaHovered ? 'bg-[#03B800] shadow-[0_0_8px_#03B800]' : 'bg-[#03B800]'
                      }`}
                    />
                    <span className="font-kanit font-medium text-lg text-[var(--rm-paper)]">
                      สมัครเข้าร่วมค่าย
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-xs text-[var(--rm-paper)]/85 group-hover:text-[var(--rm-paper)]">
                    <span>/register</span>
                    <span className="transform transition-transform duration-200 group-hover:translate-x-1">-&gt;</span>
                  </div>
                </a>

                <a
                  href="/status"
                  data-astro-prefetch="false"
                  onMouseEnter={() => setSecondaryCtaHovered(true)}
                  onMouseLeave={() => setSecondaryCtaHovered(false)}
                  className="rm-btn-sharp rm-btn-secondary flex-1 flex items-center justify-between px-6 cursor-pointer group min-h-[56px] sm:min-h-[64px]"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-2 h-2 rounded-full border border-[var(--rm-ink)] transition-colors duration-200 ${
                        secondaryCtaHovered ? 'border-[#00B4D8] bg-[#00B4D8]' : ''
                      }`}
                    />
                    <span className="font-kanit font-medium text-lg text-[var(--rm-ink)]">
                      ตรวจสอบสถานะ
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-xs text-[var(--rm-text-muted)] group-hover:text-[var(--rm-ink)]">
                    <span>/status</span>
                    <span className="transform transition-transform duration-200 group-hover:translate-x-1">-&gt;</span>
                  </div>
                </a>
              </div>
            </div>

            {/* Col 8–12: Display Numeral "25" rendered as Locked-Aspect SVG (Zero CLS, Zero Contrast False Positive) */}
            <div
              className="lg:col-span-5 relative flex items-center justify-center lg:justify-end select-none pointer-events-none"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 360 260"
                className="w-[220px] sm:w-[300px] xl:w-[420px] h-auto overflow-visible"
                aria-hidden="true"
              >
                <text
                  x="100%"
                  y="215"
                  textAnchor="end"
                  className="font-momo text-[240px] tracking-[-0.04em]"
                  fill="currentColor"
                  fillOpacity={isDark ? '0.08' : '0.10'}
                >
                  25
                </text>
              </svg>
            </div>
          </div>

          {/* Bottom Factual Spec Strip */}
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 pt-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 border-t border-[var(--rm-hairline)] pt-4 gap-4 font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex flex-col">
                <span className="text-[10px] text-[var(--rm-text-subtle)] uppercase">ELIGIBILITY</span>
                <span className="font-kanit text-sm text-[var(--rm-ink)] font-normal">ม.4–ม.6 และ ปวช.1–ปวช.3</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-[var(--rm-text-subtle)] uppercase">HARDWARE PLATFORMS</span>
                <span className="text-sm text-[var(--rm-ink)] font-mono">UNO R3 + ESP8266 NODEMCU</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-[var(--rm-text-subtle)] uppercase">DEPARTMENT</span>
                <span className="font-kanit text-sm text-[var(--rm-ink)] font-normal">วิทยาการคอมพิวเตอร์ ม.แม่โจ้</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-[var(--rm-text-subtle)] uppercase">NEXT SECTION</span>
                <a href="#thesis" className="text-sm rm-text-blue font-mono font-medium hover:underline py-1">
                  02 — THESIS (BLINK x 2) v
                </a>
              </div>
            </div>
          </div>
        </section>


        {/* ============================================================
            02 · THESIS / THE TWO BLINKS
            ============================================================ */}
        <section
          id="thesis"
          className="relative w-full py-20 lg:py-28 border-b border-[var(--rm-hairline)] overflow-hidden"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="w-full flex items-center justify-between pb-4 mb-14 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="text-[var(--rm-ink)] font-semibold">02</span>
                <span>—</span>
                <span>THESIS / THE TWO BLINKS</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">PCB FR-4 PROFILE GAUGE</span>
                <span>CC25-RM · p.02</span>
              </div>
            </div>

            <div className="max-w-4xl mx-auto my-4 text-center z-20">
              <h2 className="font-kanit font-medium text-2xl sm:text-4xl lg:text-[42px] leading-snug text-[var(--rm-ink)]">
                &ldquo;ในค่ายนี้ น้องจะทำให้ไฟดวงเดิมกระพริบสองครั้ง — ครั้งแรกวิ่งผ่านสายทองแดงบน{' '}
                <span className="font-mono font-semibold border-b-2 border-[#337AFF] text-[var(--rm-ink)]">
                  UNO R3
                </span>{' '}
                ครั้งที่สองวิ่งข้ามอากาศผ่านคลื่นวิทยุบน{' '}
                <span className="font-mono font-semibold border-b-2 border-[#00B4D8] text-[var(--rm-ink)]">
                  ESP8266
                </span>
                &rdquo;
              </h2>
            </div>

            <div
              id="viewport-thesis"
              className="w-full max-w-4xl mx-auto my-10 py-10 px-6 border-y border-[var(--rm-hairline)] rm-cad-grid flex flex-col gap-12 relative"
            >
              <div className="flex items-center gap-4">
                <div className="w-28 font-mono text-[11px] rm-text-blue tracking-wider text-right font-semibold">
                  UNO R3 · 1.6mm
                </div>
                <div className="flex-1 h-px bg-[#337AFF]/50 relative">
                  <span className="absolute -top-2.5 left-4 font-mono text-[9px] text-[var(--rm-text-subtle)] bg-[var(--rm-paper)] px-1">
                    FR-4 SUBSTRATE · 5V LOGIC LEVEL
                  </span>
                </div>
                <div className="w-20 font-mono text-[11px] text-[var(--rm-text-muted)]">WIRED I/O</div>
              </div>

              <div className="flex items-center gap-4">
                <div className="w-28 font-mono text-[11px] rm-text-cyan tracking-wider text-right font-semibold">
                  ESP8266 · 1.6mm
                </div>
                <div className="flex-1 h-px bg-[#00B4D8]/50 relative">
                  <span className="absolute -top-2.5 left-4 font-mono text-[9px] text-[var(--rm-text-subtle)] bg-[var(--rm-paper)] px-1">
                    RF SHIELDED · 3.3V WIRELESS NODE
                  </span>
                </div>
                <div className="w-20 font-mono text-[11px] text-[var(--rm-text-muted)]">2.4GHz AIR</div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-16 max-w-4xl mx-auto mt-4 font-kanit z-20">
              <div className="flex flex-col border-l-2 border-[#337AFF] pl-6 bg-[var(--rm-paper)]/90">
                <div className="font-silkscreen text-xs rm-text-blue font-semibold mb-2">
                  BLINK #01 · WIRED LOGIC
                </div>
                <h3 className="text-xl font-medium text-[var(--rm-ink)] mb-3">
                  เข้าใจรากฐานของตรรกะไฟฟ้าและขาสัญญาณ
                </h3>
                <p className="text-base text-[var(--rm-text-muted)] font-light leading-relaxed">
                  เริ่มต้นจากศูนย์ด้วยการทำความเข้าใจสถานะ HIGH / LOW (1 กับ 0), การต่อวงจรอ่านค่าเซนเซอร์แสง
                  และการเขียนคำสั่งควบคุมขาสัญญาณไฟฟ้าผ่านสาย USB บนบอร์ดครู Arduino UNO R3
                </p>
              </div>

              <div className="flex flex-col border-l-2 border-[#00B4D8] pl-6 bg-[var(--rm-paper)]/90">
                <div className="font-silkscreen text-xs rm-text-cyan font-semibold mb-2">
                  BLINK #02 · WIRELESS NODE
                </div>
                <h3 className="text-xl font-medium text-[var(--rm-ink)] mb-3">
                  ปลดล็อกระยะสายไฟด้วยเครือข่ายไร้สาย IoT
                </h3>
                <p className="text-base text-[var(--rm-text-muted)] font-light leading-relaxed">
                  นำโครงสร้างโค้ดที่เพิ่งเรียนรู้มาอัปเกรดขึ้นสู่สถาปัตยกรรม 32-bit ส่งคำสั่งข้ามอากาศผ่านคลื่นความถี่ 2.4 GHz (Wi-Fi)
                  เพื่อสั่งเปิด-ปิดอุปกรณ์จริงจากหน้าจอสมาร์ทโฟนบน ESP8266
                </p>
              </div>
            </div>

          </div>
        </section>


        {/* ============================================================
            03 · BOARD 01 / ARDUINO UNO R3
            ============================================================ */}
        <section
          id="board-uno"
          className="relative w-full py-20 lg:py-28 border-b border-[var(--rm-hairline)]"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="w-full flex items-center justify-between pb-4 mb-10 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="rm-text-blue font-semibold">03</span>
                <span>—</span>
                <span>BOARD 01 / ARDUINO UNO R3</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">SUBSYSTEM INSPECTION</span>
                <span>CC25-RM · p.03</span>
              </div>
            </div>

            <div className="mb-8">
              <span className="font-silkscreen text-xs rm-text-blue block mb-1 font-semibold">
                HARDWARE SUBSYSTEM 01 · ATMEGA328P
              </span>
              <h2 className="font-kanit font-medium text-3xl sm:text-4xl text-[var(--rm-ink)]">
                บอร์ดครูเรือนแรก: ตรรกะไฟฟ้า เซนเซอร์ และขาสัญญาณ
              </h2>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              
              <div
                id="viewport-uno"
                className="lg:col-span-7 h-[300px] sm:h-[360px] lg:h-[580px] relative flex flex-col justify-between p-5 border border-[var(--rm-hairline-strong)] rounded-[2px] bg-[var(--rm-surface-subtle)]/35 rm-cad-grid order-1 lg:order-2"
              >
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <div className="flex items-center gap-2 text-[var(--rm-text-subtle)]">
                    <span className="rm-crosshair" aria-hidden="true" />
                    <span>3D VIEWPORT · ARDUINO UNO R3</span>
                  </div>
                  <div className="flex items-center gap-1.5 rm-text-blue font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#337AFF]" />
                    <span>NODE 0{unoHotspotIndex + 1} · {UNO_HOTSPOTS[unoHotspotIndex].label}</span>
                  </div>
                </div>

                <div className="font-mono text-xs text-[var(--rm-text-muted)] flex items-center justify-between border-t border-[var(--rm-hairline)] pt-3">
                  <span>ATmega328P · 16MHz · 5V LOGIC</span>
                  <div className="flex items-center gap-2">
                    <span>14 DIGITAL · 6 PWM · 6 ANALOG</span>
                    <span className="rm-crosshair" aria-hidden="true" />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-5 flex flex-col gap-2 z-20 order-2 lg:order-1">
                {UNO_HOTSPOTS.map((hp, idx) => {
                  const isActive = unoHotspotIndex === idx;
                  return (
                    <div
                      key={hp.code}
                      id={`hotspot-uno-${idx}`}
                      onClick={() => setUnoHotspotIndex(idx)}
                      className={`p-3.5 sm:p-4 rounded-[2px] border transition-all cursor-pointer bg-[var(--rm-paper)] ${
                        isActive
                          ? 'border-[#337AFF] shadow-sm ring-1 ring-[#337AFF]/30'
                          : 'border-[var(--rm-hairline)] hover:border-[var(--rm-hairline-strong)]'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2 font-mono text-xs">
                          <span className={isActive ? 'rm-text-blue font-bold' : 'text-[var(--rm-text-subtle)]'}>
                            {hp.code}
                          </span>
                          <span className="font-semibold text-[var(--rm-ink)]">{hp.label}</span>
                        </div>
                        <span className="font-mono text-[10px] rm-text-blue px-2 py-0.5 bg-[#337AFF]/10 border border-[#337AFF]/20 rounded-[1px] font-medium">
                          {hp.tag}
                        </span>
                      </div>
                      <p className="font-kanit text-xs sm:text-[13px] text-[var(--rm-text-muted)] leading-relaxed">
                        {hp.desc}
                      </p>
                    </div>
                  );
                })}

                {unoHotspotIndex === 6 && (
                  <div className="mt-2 p-4 border border-[#337AFF]/40 bg-[var(--rm-surface)] rounded-[2px] font-mono text-xs">
                    <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--rm-hairline)]">
                      <span className="rm-text-blue font-semibold">USB-B SERIAL · COM3 (9600 BAUD)</span>
                      <span className="text-[10px] text-[var(--rm-text-subtle)]">PIN D13 OUTPUT</span>
                    </div>
                    <p className="font-kanit text-xs text-[var(--rm-ink)] mb-3">
                      ทดลองส่งคำสั่งเปิด-ปิดไฟ LED ดวงแรกผ่านสาย USB ลงสู่ขาพิน D13 บนบอร์ด UNO R3:
                    </p>
                    <button
                      onClick={() => setUnoWiredLedToggled((prev) => !prev)}
                      className="w-full py-3 px-4 min-h-[48px] rounded-[2px] border border-[#337AFF] text-[var(--rm-ink)] bg-[var(--rm-paper)] hover:bg-[#337AFF]/10 flex items-center justify-between transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            unoWiredLedToggled ? 'bg-[#337AFF] shadow-[0_0_8px_#337AFF]' : 'border border-[#337AFF]'
                          }`}
                        />
                        <span>digitalWrite(13, {unoWiredLedToggled ? 'LOW' : 'HIGH'});</span>
                      </span>
                      <span className="font-kanit font-medium text-xs rm-text-blue">
                        {unoWiredLedToggled ? 'สถานะ HIGH (คลิกเพื่อสั่ง LOW)' : 'คลิกเพื่อจ่ายไฟ 5V เข้าขา D13'}
                      </span>
                    </button>
                  </div>
                )}

                <div className="flex items-center justify-between pt-3 mt-2 border-t border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
                  <span>HOTSPOT {unoHotspotIndex + 1} / 7</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setUnoHotspotIndex((prev) => (prev > 0 ? prev - 1 : 6))}
                      className="px-4 py-2 min-h-[44px] flex items-center justify-center border border-[var(--rm-hairline-strong)] rounded-[2px] hover:bg-[var(--rm-surface)] cursor-pointer"
                      aria-label="Previous Arduino Uno hotspot"
                    >
                      PREV
                    </button>
                    <button
                      onClick={() => setUnoHotspotIndex((prev) => (prev < 6 ? prev + 1 : 0))}
                      className="px-4 py-2 min-h-[44px] flex items-center justify-center border border-[#337AFF] rm-text-blue rounded-[2px] hover:bg-[#337AFF]/10 cursor-pointer font-medium"
                      aria-label="Next Arduino Uno hotspot"
                    >
                      NEXT
                    </button>
                  </div>
                </div>
              </div>

            </div>

            <div className="mt-12 pt-4 border-t border-[var(--rm-hairline)] flex flex-col gap-1 font-kanit text-xs text-[var(--rm-text-subtle)]">
              <div>¹ Serial Monitor: หน้าต่างแสดงผลข้อความและค่าตัวเลขที่รับ-ส่งแบบเรียลไทม์ระหว่างบอร์ดไมโครคอนโทรลเลอร์กับคอมพิวเตอร์ผ่านสาย USB</div>
              <div>² PWM (Pulse Width Modulation): เทคนิคการเปิด-ปิดสัญญาณดิจิทัลด้วยความถี่สูงเพื่อจำลองระดับแรงดันไฟฟ้าตั้งแต่ 0% ถึง 100%</div>
            </div>

          </div>
        </section>


        {/* ============================================================
            04 · SIGNAL BRIDGE / WIRE TO AIR
            ============================================================ */}
        <section
          id="bridge"
          className="relative w-full py-24 lg:py-32 border-b border-[var(--rm-hairline)] overflow-hidden"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="w-full flex items-center justify-between pb-4 mb-12 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="text-[var(--rm-ink)] font-semibold">04</span>
                <span>—</span>
                <span>SIGNAL BRIDGE / WIRE TO AIR</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">MEDIUM TRANSITION</span>
                <span>CC25-RM · p.04</span>
              </div>
            </div>

            <div className="flex items-center justify-between font-mono text-xs mb-8">
              <span className="rm-text-blue font-semibold">[ COPPER TRACE · USB SERIAL · 5V LOGIC ]</span>
              <span className="rm-text-cyan font-semibold">[ IEEE 802.11 b/g/n · 2.4 GHz RF ]</span>
            </div>

            <div id="viewport-bridge" className="my-14 py-8 text-center max-w-3xl mx-auto z-20">
              <h2 className="font-kanit font-medium text-3xl sm:text-4xl lg:text-5xl leading-tight text-[var(--rm-ink)]">
                สายทองแดงมีจุดสิ้นสุดแค่ปลายโต๊ะแล็บ
                <br />
                <span className="text-[var(--rm-text-muted)] font-light">
                  แต่คลื่นสัญญาณเดินทางได้ไกลเท่าที่เครือข่ายไปถึง
                </span>
              </h2>
            </div>

            <div className="text-center max-w-xl mx-auto font-kanit text-sm text-[var(--rm-text-muted)] z-20">
              เปลี่ยนผ่านจากสัญญาณไฟฟ้าบนขา Pin D13 ที่ต้องพึ่งพาสายเคเบิล สู่การเข้ารหัสแพ็กเกจข้อมูลส่งผ่านสายอากาศ PCB Antenna บนความถี่ 2.4 GHz
            </div>

          </div>
        </section>


        {/* ============================================================
            05 · BOARD 02 / ESP8266 NODEMCU (Mirrored Layout)
            ============================================================ */}
        <section
          id="board-esp"
          className="relative w-full py-20 lg:py-28 border-b border-[var(--rm-hairline)]"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="w-full flex items-center justify-between pb-4 mb-10 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="rm-text-cyan font-semibold">05</span>
                <span>—</span>
                <span>BOARD 02 / ESP8266 NODEMCU</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">WIRELESS NODE INSPECTION</span>
                <span>CC25-RM · p.05</span>
              </div>
            </div>

            <div className="mb-8">
              <span className="font-silkscreen text-xs rm-text-cyan block mb-1 font-semibold">
                HARDWARE SUBSYSTEM 02 · TENSILICA L106 + WI-FI
              </span>
              <h2 className="font-kanit font-medium text-3xl sm:text-4xl text-[var(--rm-ink)]">
                โหนดไร้สาย 32-bit: เมื่อโค้ดของคุณกระโดดขึ้นสู่อากาศ
              </h2>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              
              <div
                id="viewport-esp"
                className="lg:col-span-7 h-[300px] sm:h-[360px] lg:h-[580px] relative flex flex-col justify-between p-5 border border-[var(--rm-hairline-strong)] rounded-[2px] bg-[var(--rm-surface-subtle)]/35 rm-cad-grid order-1"
              >
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <div className="flex items-center gap-2 text-[var(--rm-text-subtle)]">
                    <span className="rm-crosshair" aria-hidden="true" />
                    <span>3D VIEWPORT · ESP8266 NODEMCU</span>
                  </div>
                  <div className="flex items-center gap-1.5 rm-text-cyan font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00B4D8]" />
                    <span>RF NODE 0{espHotspotIndex + 1} · {ESP_HOTSPOTS[espHotspotIndex].label}</span>
                  </div>
                </div>

                <div className="font-mono text-xs text-[var(--rm-text-muted)] flex items-center justify-between border-t border-[var(--rm-hairline)] pt-3">
                  <span>Tensilica L106 · 80MHz · 3.3V LOGIC</span>
                  <div className="flex items-center gap-2">
                    <span>4MB FLASH · 802.11 b/g/n</span>
                    <span className="rm-crosshair" aria-hidden="true" />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-5 flex flex-col gap-2 z-20 order-2">
                {ESP_HOTSPOTS.map((hp, idx) => {
                  const isActive = espHotspotIndex === idx;
                  return (
                    <div
                      key={hp.code}
                      id={`hotspot-esp-${idx}`}
                      onClick={() => setEspHotspotIndex(idx)}
                      className={`p-3.5 sm:p-4 rounded-[2px] border transition-all cursor-pointer bg-[var(--rm-paper)] ${
                        isActive
                          ? 'border-[#00B4D8] shadow-sm ring-1 ring-[#00B4D8]/30'
                          : 'border-[var(--rm-hairline)] hover:border-[var(--rm-hairline-strong)]'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2 font-mono text-xs">
                          <span className={isActive ? 'rm-text-cyan font-bold' : 'text-[var(--rm-text-subtle)]'}>
                            {hp.code}
                          </span>
                          <span className="font-semibold text-[var(--rm-ink)]">{hp.label}</span>
                        </div>
                        <span className="font-mono text-[10px] rm-text-cyan px-2 py-0.5 bg-[#00B4D8]/10 border border-[#00B4D8]/20 rounded-[1px] font-medium">
                          {hp.tag}
                        </span>
                      </div>
                      <p className="font-kanit text-xs sm:text-[13px] text-[var(--rm-text-muted)] leading-relaxed">
                        {hp.desc}
                      </p>
                    </div>
                  );
                })}

                {espHotspotIndex === 6 && (
                  <div className="mt-2 p-4 border-2 border-[#00B4D8]/60 bg-[var(--rm-surface)] rounded-[4px] font-mono text-xs relative">
                    <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-[var(--rm-hairline)] text-[10px]">
                      <span className="rm-text-cyan font-semibold">SSID: CC25_NODEMCU_AP</span>
                      <span className="text-[var(--rm-text-subtle)]">RSSI -42 dBm · 12 ms</span>
                    </div>
                    <div className="px-2.5 py-1.5 mb-3 bg-[var(--rm-paper)] border border-[var(--rm-hairline-strong)] rounded-[2px] flex items-center justify-between text-[11px]">
                      <span className="text-[var(--rm-ink)]">http://192.168.4.1/led/{wifiLedToggled ? 'on' : 'off'}</span>
                      <span className="rm-text-green font-semibold">200 OK</span>
                    </div>
                    <p className="font-kanit text-xs text-[var(--rm-ink)] mb-3">
                      จำลองหน้าจอมือถือสั่งเปิด-ปิดไฟ LED บนบอร์ด ESP8266 ผ่านโปรโตคอล HTTP แบบไร้สาย:
                    </p>
                    <button
                      onClick={() => setWifiLedToggled((prev) => !prev)}
                      className="w-full py-3 px-4 min-h-[48px] rounded-[2px] border border-[#00B4D8] text-[var(--rm-ink)] bg-[var(--rm-paper)] hover:bg-[#00B4D8]/10 flex items-center justify-between transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            wifiLedToggled ? 'bg-[#00B4D8] shadow-[0_0_8px_#00B4D8]' : 'border border-[#00B4D8]'
                          }`}
                        />
                        <span>[ GET /led/{wifiLedToggled ? 'off' : 'on'} ]</span>
                      </span>
                      <span className="font-kanit font-medium text-xs rm-text-cyan">
                        {wifiLedToggled ? 'ไฟติดแล้ว (แตะเพื่อสั่งดับ)' : 'แตะเพื่อยิงคำสั่งเปิดไฟผ่าน Wi-Fi'}
                      </span>
                    </button>
                  </div>
                )}

                <div className="flex items-center justify-between pt-3 mt-2 border-t border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
                  <span>HOTSPOT {espHotspotIndex + 1} / 7</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEspHotspotIndex((prev) => (prev > 0 ? prev - 1 : 6))}
                      className="px-4 py-2 min-h-[44px] flex items-center justify-center border border-[var(--rm-hairline-strong)] rounded-[2px] hover:bg-[var(--rm-surface)] cursor-pointer"
                      aria-label="Previous ESP8266 hotspot"
                    >
                      PREV
                    </button>
                    <button
                      onClick={() => setEspHotspotIndex((prev) => (prev < 6 ? prev + 1 : 0))}
                      className="px-4 py-2 min-h-[44px] flex items-center justify-center border border-[#00B4D8] rm-text-cyan rounded-[2px] hover:bg-[#00B4D8]/10 cursor-pointer font-medium"
                      aria-label="Next ESP8266 hotspot"
                    >
                      NEXT
                    </button>
                  </div>
                </div>
              </div>

            </div>

            <div className="mt-12 pt-4 border-t border-[var(--rm-hairline)] font-kanit text-xs text-[var(--rm-text-subtle)]">
              ¹ GPIO (General-Purpose Input/Output): ขาสัญญาณอเนกประสงค์ที่สามารถเขียนโค้ดกำหนดทิศทางให้เป็นขารับค่าเซนเซอร์ (Input) หรือขาส่งคำสั่งควบคุม (Output) ได้อย่างอิสระ
            </div>

          </div>
        </section>


        {/* ============================================================
            06 · SPEC SHEET / HARDWARE COMPARISON
            ============================================================ */}
        <section
          id="spec"
          className="relative w-full py-20 lg:py-28 border-b border-[var(--rm-hairline)]"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="w-full flex items-center justify-between pb-4 mb-10 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="text-[var(--rm-ink)] font-semibold">06</span>
                <span>—</span>
                <span>SPEC SHEET / HARDWARE COMPARISON</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">METROLOGY &amp; DATASHEET</span>
                <span>CC25-RM · p.06</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 gap-4">
              <div>
                <span className="font-silkscreen text-xs text-[var(--rm-text-subtle)] block mb-1">
                  TRUE-SCALE HARDWARE DATASHEET (1.00 : 0.71)
                </span>
                <h2 className="font-kanit font-medium text-3xl sm:text-4xl text-[var(--rm-ink)]">
                  เทียบสเปกสถาปัตยกรรม: จากบอร์ดฝึกหัดสู่โหนดไร้สาย
                </h2>
              </div>
              <p className="font-kanit text-xs sm:text-sm text-[var(--rm-text-muted)]">
                ชี้หรือแตะที่แถวตารางด้านล่าง เพื่อส่องตำแหน่งชิ้นส่วนเปรียบเทียบบนบอร์ด 3D ทั้งสองตัวพร้อมกัน
              </p>
            </div>

            <div
              id="viewport-spec"
              className="w-full h-56 sm:h-64 mb-8 border border-[var(--rm-hairline-strong)] rounded-[2px] rm-cad-grid flex flex-col justify-between p-4 font-mono text-xs bg-[var(--rm-surface-subtle)]/35 relative"
            >
              <div className="flex items-center justify-between text-[11px] text-[var(--rm-text-subtle)]">
                <div className="flex items-center gap-2">
                  <span className="rm-crosshair" aria-hidden="true" />
                  <span>TRUE-SCALE PLAN VIEW CHAMBER</span>
                </div>
                <span>
                  {specHoveredRow
                    ? `INSPECTING PARAMETER: ${specHoveredRow.toUpperCase()}`
                    : 'HOVER ANY DATASHEET ROW TO COMPARE NODES'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-2 border-t border-[var(--rm-hairline)]">
                <div className="flex items-center justify-between pr-4 border-r border-[var(--rm-hairline)]">
                  <span className="rm-text-blue font-semibold">ARDUINO UNO R3</span>
                  <span className="text-[11px] text-[var(--rm-text-muted)]">68.6 × 53.4 mm (SCALE 1.00)</span>
                </div>
                <div className="flex items-center justify-between pl-2">
                  <span className="rm-text-cyan font-semibold">ESP8266 NODEMCU</span>
                  <span className="text-[11px] text-[var(--rm-text-muted)]">~49.0 × 26.0 mm (SCALE 0.71)</span>
                </div>
              </div>
            </div>

            <div className="w-full overflow-x-auto bg-[var(--rm-paper)] border border-[var(--rm-hairline-strong)] rounded-[2px] z-20">
              <table className="w-full text-left font-mono text-xs sm:text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--rm-hairline-strong)] bg-[var(--rm-surface-subtle)] text-[var(--rm-text-muted)] text-[11px]">
                    <th className="py-3.5 px-4 uppercase font-semibold">PARAMETER</th>
                    <th className="py-3.5 px-4 uppercase font-semibold rm-text-blue">BOARD 01 · ARDUINO UNO R3</th>
                    <th className="py-3.5 px-4 uppercase font-semibold rm-text-cyan">BOARD 02 · ESP8266 NODEMCU</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--rm-hairline)]">
                  {DATASHEET_ROWS.map((row) => {
                    const isHovered = specHoveredRow === row.id;
                    return (
                      <tr
                        key={row.id}
                        onMouseEnter={() => setSpecHoveredRow(row.id)}
                        onMouseLeave={() => setSpecHoveredRow(null)}
                        onClick={() => setSpecHoveredRow((prev) => (prev === row.id ? null : row.id))}
                        className={`transition-colors cursor-pointer ${
                          isHovered ? 'bg-[var(--rm-surface)]' : 'hover:bg-[var(--rm-surface-subtle)]'
                        }`}
                      >
                        <td className="py-4 px-4 font-semibold text-[var(--rm-ink)] flex items-center gap-2">
                          <span
                            className={`w-1.5 h-1.5 rounded-full transition-opacity ${
                              isHovered ? 'bg-[#337AFF] opacity-100' : 'opacity-0'
                            }`}
                          />
                          <span>{row.label}</span>
                        </td>
                        <td className="py-4 px-4 text-[var(--rm-text-muted)]">{row.uno}</td>
                        <td className="py-4 px-4 text-[var(--rm-text-muted)]">{row.esp}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

          </div>
        </section>


        {/* ============================================================
            07 · SIGNAL PATH / FOUNDATION OF CS
            ============================================================ */}
        <section
          id="path"
          className="relative w-full py-20 lg:py-28 border-b border-[var(--rm-hairline)]"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="w-full flex items-center justify-between pb-4 mb-10 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="text-[var(--rm-ink)] font-semibold">07</span>
                <span>—</span>
                <span>SIGNAL PATH / FOUNDATION OF CS</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">CURRICULUM ARCHITECTURE</span>
                <span>CC25-RM · p.07</span>
              </div>
            </div>

            <div className="mb-14">
              <span className="font-silkscreen text-xs text-[var(--rm-text-subtle)] block mb-1">
                LEARNING PIPELINE TO COMPUTER SCIENCE
              </span>
              <h2 className="font-kanit font-medium text-3xl sm:text-4xl lg:text-[42px] leading-tight text-[var(--rm-ink)] max-w-3xl">
                ทุกขาสัญญาณที่ได้ลองต่อ คือบทเรียนแรกของวิทยาการคอมพิวเตอร์
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-6 relative z-20">
              <div className="hidden md:block absolute top-6 left-6 right-6 h-px bg-[var(--rm-hairline-strong)] z-0" />

              {SIGNAL_NODES.map((node, index) => {
                const isWirelessPhase = index >= 3;
                return (
                  <div
                    key={node.step}
                    className="flex flex-col relative z-10 bg-[var(--rm-paper)] p-4 rounded-[2px] border border-[var(--rm-hairline)] hover:border-[var(--rm-hairline-strong)] transition-colors"
                  >
                    <div
                      className={`w-12 h-12 rounded-[2px] bg-[var(--rm-paper)] border flex items-center justify-center font-mono text-xs font-bold mb-4 ${
                        isWirelessPhase
                          ? 'border-[#00B4D8] rm-text-cyan'
                          : 'border-[#337AFF] rm-text-blue'
                      }`}
                    >
                      {node.step}
                    </div>

                    <div
                      className={`font-silkscreen text-xs font-semibold mb-2 ${
                        isWirelessPhase ? 'rm-text-cyan' : 'rm-text-blue'
                      }`}
                    >
                      {node.phase}
                    </div>

                    <div className="font-kanit text-sm font-medium text-[var(--rm-ink)] mb-2 leading-snug">
                      {node.camp}
                    </div>

                    <div className="font-kanit text-xs text-[var(--rm-text-muted)] font-light leading-relaxed mt-auto pt-2 border-t border-[var(--rm-hairline-subtle)]">
                      {node.cs}
                    </div>
                  </div>
                );
              })}
            </div>

          </div>
        </section>


        {/* ============================================================
            08 · COMPATIBILITY / ELIGIBILITY PINS
            ============================================================ */}
        <section
          id="compatibility"
          className="relative w-full py-20 lg:py-28 border-b border-[var(--rm-hairline)]"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="w-full flex items-center justify-between pb-4 mb-10 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="text-[var(--rm-ink)] font-semibold">08</span>
                <span>—</span>
                <span>COMPATIBILITY / ELIGIBILITY PINS</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">ANALOG INPUT CHANNELS A0–A5</span>
                <span>CC25-RM · p.08</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-10 gap-4">
              <div>
                <span className="font-silkscreen text-xs rm-text-green block mb-1 font-semibold">
                  SYSTEM COMPATIBILITY MATRIX · SELECT YOUR GRADE CHANNEL
                </span>
                <h2 className="font-kanit font-medium text-3xl sm:text-4xl text-[var(--rm-ink)]">
                  ขาสัญญาณ A0–A5: เปิดรับน้องสายสามัญและสายอาชีวะ
                </h2>
              </div>
              <p className="font-kanit text-xs sm:text-sm text-[var(--rm-text-muted)]">
                คลิกเลือกขาสัญญาณที่ตรงกับชั้นปีของน้องเพื่อตรวจสอบสถานะความพร้อม
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6 z-20">
              {COMPATIBILITY_PINS.map((pin, idx) => {
                const isSelected = selectedAnalogPin === idx;
                return (
                  <button
                    key={pin.pin}
                    type="button"
                    onClick={() => setSelectedAnalogPin(idx)}
                    className={`p-4 text-left border rounded-[2px] transition-all cursor-pointer flex flex-col justify-between min-h-[128px] ${
                      isSelected
                        ? 'border-[#03B800] bg-[var(--rm-surface)] ring-1 ring-[#03B800]/30'
                        : 'border-[var(--rm-hairline)] bg-[var(--rm-paper)] hover:border-[var(--rm-hairline-strong)]'
                    }`}
                  >
                    <div className="w-full flex items-center justify-between mb-3">
                      <span
                        className={`font-mono text-xs font-bold px-1.5 py-0.5 rounded-[1px] border ${
                          isSelected
                            ? 'border-[#03B800] rm-text-green bg-[#03B800]/10'
                            : 'border-[var(--rm-hairline-strong)] text-[var(--rm-text-muted)]'
                        }`}
                      >
                        {pin.pin}
                      </span>
                      <span
                        className={`w-2 h-2 rounded-full ${
                          isSelected ? 'bg-[#03B800] shadow-[0_0_8px_#03B800]' : 'bg-[#03B800]/40'
                        }`}
                      />
                    </div>
                    <div>
                      <span className="font-kanit text-xl font-medium text-[var(--rm-ink)] block">
                        {pin.level}
                      </span>
                      <span className="font-kanit text-xs text-[var(--rm-text-muted)] font-light block mt-1">
                        {pin.desc}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div
              role="status"
              aria-live="polite"
              className="mb-10 p-4 border border-[var(--rm-hairline-strong)] bg-[var(--rm-surface-subtle)] rounded-[2px] flex flex-col md:flex-row md:items-center justify-between gap-4 z-20"
            >
              <div className="flex items-start sm:items-center gap-3">
                <span className="px-2 py-1 font-mono text-xs font-bold bg-[#03B800]/15 border border-[#03B800]/40 rm-text-green rounded-[2px]">
                  analogRead({activeEligibility.pin}) == {activeEligibility.adc}
                </span>
                <p className="font-kanit text-sm text-[var(--rm-ink)]">
                  <strong className="font-medium">{activeEligibility.level}:</strong> {activeEligibility.note}
                </p>
              </div>
              <div className="font-mono text-xs rm-text-green font-semibold shrink-0">
                [ V_REF: {activeEligibility.voltage} · COMPATIBLE ]
              </div>
            </div>

            <div className="flex flex-col divide-y divide-[var(--rm-hairline)] border-y border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)] z-20 bg-[var(--rm-paper)]">
              <div className="py-4 grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                <span className="md:col-span-4 text-[var(--rm-text-subtle)] uppercase">REQUIRED EXPERIENCE</span>
                <span className="md:col-span-8 font-kanit text-sm text-[var(--rm-ink)] font-normal">
                  ไม่จำเป็นต้องมีพื้นฐานการเขียนโปรแกรมหรือต่อวงจรมาก่อน พี่ๆ ปูพื้นฐานให้ใหม่ตั้งแต่ไฟกระพริบดวงแรก
                </span>
              </div>
              <div className="py-4 grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                <span className="md:col-span-4 text-[var(--rm-text-subtle)] uppercase">CORE INTEREST</span>
                <span className="md:col-span-8 font-mono text-xs sm:text-sm text-[var(--rm-ink)]">
                  Computer Science · Programming · Microcontroller (UNO R3 &amp; ESP8266) · IoT
                </span>
              </div>
              <div className="py-4 grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                <span className="md:col-span-4 text-[var(--rm-text-subtle)] uppercase">OFFICIAL NOTICE</span>
                <span className="md:col-span-8 font-kanit text-xs sm:text-sm text-[var(--rm-text-muted)] font-normal">
                  รายละเอียดและกำหนดการอย่างเป็นทางการจะประกาศผ่านช่องทางหลักของสาขาวิชาวิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้
                </span>
              </div>
            </div>

          </div>
        </section>


        {/* ============================================================
            09 · POWER ON / INITIALIZE APPLICATION
            ============================================================ */}
        <section
          id="power-on"
          className="relative w-full py-24 lg:py-36 border-b border-[var(--rm-hairline)] rm-mesh-gradient overflow-hidden"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col items-center text-center">
            
            <div className="w-full flex items-center justify-between pb-4 mb-16 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)] text-left">
              <div className="flex items-center gap-2.5">
                <span className="rm-crosshair" aria-hidden="true" />
                <span className="rm-text-green font-semibold">09</span>
                <span>—</span>
                <span>POWER ON / INITIALIZE APPLICATION</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-[var(--rm-text-subtle)]">SYSTEM READY</span>
                <span>CC25-RM · p.09</span>
              </div>
            </div>

            <div className="max-w-2xl mx-auto mb-10 z-20">
              <span className="font-silkscreen text-xs rm-text-green block mb-2 font-semibold">
                READY FOR INITIALIZATION · 5V &amp; 3.3V RAILS STABLE
              </span>
              <h2 className="font-kanit font-medium text-4xl sm:text-5xl lg:text-6xl text-[var(--rm-ink)]">
                พร้อมเสียบสายเริ่มต้นระบบหรือยัง?
              </h2>
            </div>

            <div className="w-full max-w-xl grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 z-20">
              <a
                href="/register"
                data-astro-prefetch="false"
                onMouseEnter={() => setPrimaryCtaHovered(true)}
                onMouseLeave={() => setPrimaryCtaHovered(false)}
                className="rm-btn-sharp rm-btn-primary flex items-center justify-between px-6 cursor-pointer group shadow-sm hover:shadow-md min-h-[56px] sm:min-h-[64px]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-2 h-2 rounded-full transition-colors duration-200 ${
                      primaryCtaHovered ? 'bg-[#03B800] shadow-[0_0_8px_#03B800]' : 'bg-[#03B800]'
                    }`}
                  />
                  <span className="font-kanit font-medium text-lg text-[var(--rm-paper)]">
                    สมัครเข้าร่วมค่าย
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-xs text-[var(--rm-paper)]/85 group-hover:text-[var(--rm-paper)]">
                  <span>/register</span>
                  <span className="transform transition-transform duration-200 group-hover:translate-x-1">-&gt;</span>
                </div>
              </a>

              <a
                href="/status"
                data-astro-prefetch="false"
                onMouseEnter={() => setSecondaryCtaHovered(true)}
                onMouseLeave={() => setSecondaryCtaHovered(false)}
                className="rm-btn-sharp rm-btn-secondary flex items-center justify-between px-6 cursor-pointer group min-h-[56px] sm:min-h-[64px]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-2 h-2 rounded-full border border-[var(--rm-ink)] transition-colors duration-200 ${
                      secondaryCtaHovered ? 'border-[#00B4D8] bg-[#00B4D8]' : ''
                    }`}
                  />
                  <span className="font-kanit font-medium text-lg text-[var(--rm-ink)]">
                    ตรวจสอบสถานะ
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-xs text-[var(--rm-text-muted)] group-hover:text-[var(--rm-ink)]">
                  <span>/status</span>
                  <span className="transform transition-transform duration-200 group-hover:translate-x-1">-&gt;</span>
                </div>
              </a>
            </div>

            <p className="font-kanit text-xs sm:text-sm text-[var(--rm-text-muted)] max-w-md z-20">
              ส่งใบสมัครเรียบร้อยแล้ว? กดปุ่มตรวจสอบสถานะด้านขวาเพื่อติดตามผลและยืนยันสิทธิ์เข้าร่วมค่าย
            </p>

          </div>
        </section>


        {/* ============================================================
            10 · COLOPHON / SWISS FOOTER
            ============================================================ */}
        <footer
          id="colophon"
          className="relative w-full pt-16 pb-24 border-t border-[var(--rm-hairline)] bg-[var(--rm-paper)] overflow-hidden z-20"
        >
          <div className="max-w-[1440px] mx-auto w-full px-5 sm:px-10 xl:px-16 flex flex-col">
            
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 pb-12 border-b border-[var(--rm-hairline)] font-mono text-xs text-[var(--rm-text-muted)]">
              
              <div className="flex flex-col gap-2">
                <span className="text-[10px] uppercase text-[var(--rm-text-subtle)] tracking-wider">ORGANIZER</span>
                <span className="font-kanit text-sm text-[var(--rm-ink)] font-normal leading-relaxed">
                  สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้ จ.เชียงใหม่
                </span>
                <span className="text-[11px] text-[var(--rm-text-subtle)]">Computer Science, Maejo University</span>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[10px] uppercase text-[var(--rm-text-subtle)] tracking-wider">MANUAL INDEX</span>
                <div className="flex flex-col gap-1 text-[var(--rm-ink)]">
                  <a href="#overview" className="hover:text-[#1D4ED8] transition-colors py-2 min-h-[44px] flex items-center">01 REV.25 OVERVIEW</a>
                  <a href="#board-uno" className="hover:text-[#1D4ED8] transition-colors py-2 min-h-[44px] flex items-center">03 ARDUINO UNO R3</a>
                  <a href="#board-esp" className="hover:text-[#0369A1] transition-colors py-2 min-h-[44px] flex items-center">05 ESP8266 NODEMCU</a>
                  <a href="#spec" className="hover:text-[var(--rm-ink)] transition-colors py-2 min-h-[44px] flex items-center">06 SPEC SHEET</a>
                  <div className="pt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--rm-text-muted)]">
                    <a href="/register" data-astro-prefetch="false" className="rm-text-green hover:underline font-medium px-2 py-2 min-h-[44px] inline-flex items-center">/register</a>
                    <span className="text-[var(--rm-hairline-strong)]">·</span>
                    <a href="/status" data-astro-prefetch="false" className="hover:underline px-2 py-2 min-h-[44px] inline-flex items-center">/status</a>
                    <span className="text-[var(--rm-hairline-strong)]">·</span>
                    <a href="/" data-astro-prefetch="false" className="hover:underline text-[var(--rm-text-subtle)] px-2 py-2 min-h-[44px] inline-flex items-center">/ (Countdown)</a>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[10px] uppercase text-[var(--rm-text-subtle)] tracking-wider">COLOPHON</span>
                <p className="font-kanit text-xs text-[var(--rm-text-muted)] font-light leading-relaxed">
                  เรียงพิมพ์ด้วย Kanit, Momo Trust Display และ JetBrains Mono · โมเดล 3D ฮาร์ดแวร์สร้างด้วย Blender โดยพี่ค่าย CSMJU
                </p>
                <span className="text-[10px] text-[var(--rm-text-subtle)]">CC25-RM · REVISION 2026.11</span>
              </div>

              <div className="flex flex-col justify-between gap-4">
                <div>
                  <span className="text-[10px] uppercase text-[var(--rm-text-subtle)] tracking-wider block mb-2">
                    SYSTEM CONTROL
                  </span>
                  <button
                    onClick={runHardwareDiagnostic}
                    className="mb-3 w-full px-4 py-2.5 min-h-[44px] flex items-center justify-center gap-2 border border-[var(--rm-hairline-strong)] rounded-[2px] text-[var(--rm-ink)] hover:bg-[var(--rm-surface)] transition-colors cursor-pointer text-xs font-mono"
                    aria-label="Run Hardware Diagnostic Serial Monitor"
                  >
                    <span className="w-2 h-2 rounded-full bg-[#03B800]" />
                    <span>[ RUN HARDWARE DIAGNOSTIC ]</span>
                  </button>
                  <button
                    onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                    className="w-full px-4 py-2.5 min-h-[44px] flex items-center justify-center border border-[var(--rm-hairline-strong)] rounded-[2px] text-[var(--rm-ink)] hover:bg-[var(--rm-surface)] transition-colors cursor-pointer text-xs font-mono"
                    aria-label="Scroll back to top of document"
                  >
                    [ ^ RESET TO TOP ]
                  </button>
                </div>
                <div className="text-[10px] text-[var(--rm-text-subtle)]">
                  CC25-RM · REV.25 · END OF DOCUMENT
                </div>
              </div>

            </div>

            {/* Bottom Edge: Oversized Cropped "CC25" Wordmark as SVG (Zero CLS & Zero Contrast Penalty) */}
            <div
              className="w-full flex justify-center items-end select-none pointer-events-none mt-12 -mb-20 overflow-hidden"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 900 280"
                className="w-full max-w-[960px] h-auto overflow-visible translate-y-1/4"
                aria-hidden="true"
              >
                <text
                  x="50%"
                  y="240"
                  textAnchor="middle"
                  className="font-momo text-[280px] tracking-[-0.04em]"
                  fill="currentColor"
                  fillOpacity="0.04"
                >
                  CC25
                </text>
              </svg>
            </div>

          </div>
        </footer>

      </main>
    </div>
  );
};

