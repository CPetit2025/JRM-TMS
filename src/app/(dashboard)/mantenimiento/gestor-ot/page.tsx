'use client';
import React, { useState } from 'react';

export default function GestorOT() {
  const [otList, setOtList] = useState([]);
  
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Gestor de Órdenes de Trabajo</h1>
      <p className="text-gray-600 mb-6">Administración integral de OTs con motor de elegibilidad.</p>
      
      <div className="bg-white p-4 rounded shadow">
        <h2 className="text-xl font-semibold mb-2">Órdenes Recientes</h2>
        {otList.length === 0 ? (
          <p className="text-gray-500">No hay órdenes de trabajo registradas.</p>
        ) : (
          <ul>
            {otList.map((ot: any) => (
              <li key={ot.id}>{ot.ot_number} - {ot.status}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
